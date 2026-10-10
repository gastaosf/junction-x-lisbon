"""Evaluation harness (SPEC 11): run the agent over the eval set and score it against ground truth.

    python -m eval.run_eval run --effort high --concurrency 4
    python -m eval.run_eval run --no-web --tools-off streetview_lookup,satellite_tile
    python -m eval.run_eval rescore runs/<run_id> --hedge          # re-allocate logged hypotheses offline
    python -m eval.run_eval compare runs/a/results.json runs/b/results.json
"""

from __future__ import annotations

import asyncio
import csv
import json
import statistics
from collections.abc import Iterable, Mapping, Sequence
from dataclasses import asdict, dataclass, fields
from pathlib import Path
from typing import Any

import typer
from pydantic import ValidationError

from eval.build_set import DEFAULT_DATA_DIR, MANIFEST_NAME, load_manifest
from geoagent.schema import Hypothesis, Label, PanoramaTask
from geoagent.scoring import RANK_WEIGHTS, haversine_m, score_list

GROUPS: tuple[str, ...] = ("all", Label.URBAN.value, Label.NON_URBAN.value)
THRESHOLDS_M: tuple[tuple[str, float], ...] = (("within_100m", 100.0), ("within_1km", 1_000.0), ("within_10km", 10_000.0))
MAX_PANORAMA_SCORE = 2.0 * sum(RANK_WEIGHTS)  # 16,050 before the Special One's x3
PROTECTED_TOOLS = frozenset({"update_candidates", "submit_locations"})  # the answer path itself
SERVER_TOOL_NAMES = frozenset({"web_search", "web_fetch"})
_COST_KEYS = ("cost_usd", "spend_usd", "total_cost_usd", "cost")
_TIME_KEYS = ("wall_time_s", "wall_s", "elapsed_s", "duration_s", "time_s")


@dataclass(frozen=True)
class Truth:
    lat: float
    lng: float
    label: Label
    special: bool = False
    source_image_id: str = ""
    sequence: str = ""  # Mapillary sequence (one drive) the source image belongs to


@dataclass
class PanoScore:
    panorama_id: str
    label: str
    special: bool
    score: float
    max_score: float
    rank1_distance_m: float | None  # None when the export holds no answer
    best_distance_m: float | None
    multiplier: float
    origin: str
    plan: str
    n_hypotheses: int
    cost_usd: float | None
    time_s: float | None
    turns: int | None


# --- ground truth -----------------------------------------------------------------------------


def truths_from_manifest(entries: Iterable[Mapping[str, Any]]) -> dict[str, Truth]:
    """Ground truth per panorama_id. Raises ValueError naming every entry without a usable label."""
    truths: dict[str, Truth] = {}
    unlabelled: list[str] = []
    for entry in entries:
        try:
            label = Label.parse(str(entry.get("label", "")))
        except ValueError:
            unlabelled.append(str(entry["panorama_id"]))
            continue
        truths[str(entry["panorama_id"])] = Truth(
            lat=float(entry["lat"]),
            lng=float(entry["lng"]),
            label=label,
            special=bool(entry.get("special", False)),
            source_image_id=str(entry.get("source_image_id", "")),
            sequence=str(entry.get("sequence") or ""),
        )
    if unlabelled:
        raise ValueError(
            f"{len(unlabelled)} panoramas have no Urban/non-Urban label "
            f"(set them with `python -m eval.build_set label`): {', '.join(unlabelled)}"
        )
    return truths


def tasks_from_manifest(entries: Iterable[Mapping[str, Any]], data_dir: Path) -> list[PanoramaTask]:
    return [
        PanoramaTask(
            panorama_id=str(entry["panorama_id"]),
            path=data_dir / str(entry["filename"]),
            label=Label.parse(str(entry["label"])),
            timestamp=str(entry["timestamp"]) if entry.get("timestamp") else None,
            special=bool(entry.get("special", False)),
        )
        for entry in entries
    ]


# --- reading exports --------------------------------------------------------------------------


def final_locations(doc: Mapping[str, Any]) -> list[dict[str, Any]]:
    locations = (doc.get("final") or {}).get("locations") or []
    return sorted(locations, key=lambda loc: loc.get("rank", 0))


def _first_number(data: Mapping[str, Any], keys: Sequence[str]) -> float | None:
    for key in keys:
        value = data.get(key)
        if isinstance(value, (int, float)) and not isinstance(value, bool):
            return float(value)
    return None


def export_cost_time(doc: Mapping[str, Any]) -> tuple[float | None, float | None, int | None]:
    """(cost_usd, time_s, turns) from the run_end totals; time falls back to the last event's t_rel_s."""
    totals = doc.get("totals") or {}
    events = doc.get("events") or []
    time_s = _first_number(totals, _TIME_KEYS)
    if time_s is None and events:
        time_s = _first_number(events[-1], ("t_rel_s",))
    turns = _first_number(totals, ("turns",))
    return _first_number(totals, _COST_KEYS), time_s, None if turns is None else int(turns)


def _parse_hypotheses(raw: Any) -> list[Hypothesis] | None:
    if not isinstance(raw, list) or not raw:
        return None
    try:
        return [Hypothesis.model_validate(item) for item in raw]
    except ValidationError:
        return None


def logged_hypotheses(events: Sequence[Mapping[str, Any]]) -> list[Hypothesis] | None:
    """The hypotheses behind the final answer: the most recent valid set the agent recorded."""
    for event in reversed(events):
        data = event.get("data") or {}
        kind = event.get("type")
        raw: Any = None
        if kind in {"candidates_update", "final_submission"}:
            raw = data.get("hypotheses")
        elif kind == "tool_call" and (data.get("name") or data.get("tool")) in PROTECTED_TOOLS:
            raw = (data.get("input") or data.get("args") or {}).get("hypotheses")
        hypotheses = _parse_hypotheses(raw)
        if hypotheses:
            return hypotheses
    return None


def _final_event_data(doc: Mapping[str, Any]) -> Mapping[str, Any]:
    for event in reversed(doc.get("events") or []):
        if event.get("type") == "final_submission":
            return event.get("data") or {}
    return {}


def reallocate(
    doc: Mapping[str, Any], label: Label, *, hedge: bool, allow_duplicates: bool
) -> tuple[list[dict[str, Any]], str] | None:
    """Rebuild the 10 entries from the logged hypotheses under other allocator settings.

    Returns None (keep the logged answer) when there are no hypotheses to re-allocate or the
    answer was a human geocode, which overrides the allocator. Every entry carries the final
    penalty multiplier, i.e. the whole-list reading of R9.
    """
    from geoagent.allocate import allocate

    locations = final_locations(doc)
    if any(loc.get("origin") == "human_geocode" for loc in locations):
        return None
    hypotheses = logged_hypotheses(doc.get("events") or [])
    if not hypotheses:
        return None
    multiplier = float(((doc.get("final") or {}).get("penalty_state") or {}).get("multiplier", 1.0))
    origin = locations[0].get("origin", "agent") if locations else "agent"
    result = allocate(hypotheses, label, hedge=hedge, allow_duplicates=allow_duplicates)
    entries = [
        {"rank": rank, "lat": lat, "lng": lng, "multiplier": multiplier, "origin": origin}
        for rank, (lat, lng) in enumerate(result.points, start=1)
    ]
    return entries, result.plan


# --- metrics (pure) ---------------------------------------------------------------------------


def score_export(
    panorama_id: str,
    doc: Mapping[str, Any],
    truth: Truth,
    *,
    locations: Sequence[Mapping[str, Any]] | None = None,
    plan: str | None = None,
) -> PanoScore:
    """Score one export against its ground truth; `locations` overrides the logged final list."""
    entries = final_locations(doc) if locations is None else list(locations)
    points = [(float(loc["lat"]), float(loc["lng"])) for loc in entries]
    multipliers = [float(loc.get("multiplier", 1.0)) for loc in entries]
    distances = [haversine_m(lat, lng, truth.lat, truth.lng) for lat, lng in points]
    cost_usd, time_s, turns = export_cost_time(doc)
    hypotheses = logged_hypotheses(doc.get("events") or [])
    allocator = _final_event_data(doc).get("allocator") or {}
    return PanoScore(
        panorama_id=panorama_id,
        label=truth.label.value,
        special=truth.special,
        score=score_list(points, (truth.lat, truth.lng), truth.label, special=truth.special, multipliers=multipliers),
        max_score=MAX_PANORAMA_SCORE * (3 if truth.special else 1),
        rank1_distance_m=distances[0] if distances else None,
        best_distance_m=min(distances) if distances else None,
        multiplier=min(multipliers) if multipliers else 1.0,
        origin=str(entries[0].get("origin", "")) if entries else "none",
        plan=plan if plan is not None else str(allocator.get("plan", "")),
        n_hypotheses=len(hypotheses) if hypotheses else 0,
        cost_usd=cost_usd,
        time_s=time_s,
        turns=turns,
    )


def _mean(values: Sequence[float]) -> float | None:
    return statistics.fmean(values) if values else None


def _median(values: Sequence[float]) -> float | None:
    return statistics.median(values) if values else None


def summarise_group(scores: Sequence[PanoScore]) -> dict[str, Any]:
    """Metrics for one group. A panorama without an answer counts as a miss at every threshold."""
    n = len(scores)
    rank1 = [s.rank1_distance_m for s in scores if s.rank1_distance_m is not None]
    costs = [s.cost_usd for s in scores if s.cost_usd is not None]
    times = [s.time_s for s in scores if s.time_s is not None]
    total_score = sum(s.score for s in scores)
    max_total = sum(s.max_score for s in scores)
    summary: dict[str, Any] = {
        "n": n,
        "mean_score": total_score / n if n else None,
        "total_score": total_score,
        "score_share_of_max": total_score / max_total if max_total else None,
        "median_rank1_distance_m": _median(rank1),
    }
    for name, limit in THRESHOLDS_M:
        summary[name] = sum(1 for d in rank1 if d <= limit) / n if n else None
    summary.update(
        mean_cost_usd=_mean(costs),
        total_cost_usd=sum(costs) if costs else None,
        mean_time_s=_mean(times),
        median_time_s=_median(times),
    )
    return summary


def summarise(scores: Sequence[PanoScore]) -> dict[str, dict[str, Any]]:
    """Metrics over all panoramas and split by label."""
    return {
        group: summarise_group([s for s in scores if group == "all" or s.label == group]) for group in GROUPS
    }


def score_run(
    exports: Mapping[str, Mapping[str, Any]],
    truths: Mapping[str, Truth],
    *,
    hedge: bool | None = None,
    allow_duplicates: bool = True,
) -> list[PanoScore]:
    """Score every export that has ground truth. `hedge` set => re-allocate the logged hypotheses."""
    scores: list[PanoScore] = []
    for panorama_id in sorted(exports):
        truth = truths.get(panorama_id)
        if truth is None:
            continue
        doc = exports[panorama_id]
        rebuilt = None
        if hedge is not None:
            rebuilt = reallocate(doc, truth.label, hedge=hedge, allow_duplicates=allow_duplicates)
        if rebuilt is None:
            scores.append(score_export(panorama_id, doc, truth))
        else:
            scores.append(score_export(panorama_id, doc, truth, locations=rebuilt[0], plan=rebuilt[1]))
    return scores


def compare_results(a: Mapping[str, Any], b: Mapping[str, Any]) -> dict[str, Any]:
    """Per-group metric deltas (b - a) and a paired per-panorama score comparison."""
    groups: dict[str, dict[str, dict[str, float | None]]] = {}
    for group in GROUPS:
        row_a = (a.get("summary") or {}).get(group) or {}
        row_b = (b.get("summary") or {}).get(group) or {}
        groups[group] = {}
        for metric in dict.fromkeys([*row_a, *row_b]):
            va, vb = row_a.get(metric), row_b.get(metric)
            delta = vb - va if isinstance(va, (int, float)) and isinstance(vb, (int, float)) else None
            groups[group][metric] = {"a": va, "b": vb, "delta": delta}

    scores_a = {p["panorama_id"]: p["score"] for p in a.get("panoramas") or []}
    scores_b = {p["panorama_id"]: p["score"] for p in b.get("panoramas") or []}
    deltas = [scores_b[pid] - scores_a[pid] for pid in sorted(scores_a.keys() & scores_b.keys())]
    paired = {
        "n": len(deltas),
        "mean_score_delta": _mean(deltas),
        "b_better": sum(1 for d in deltas if d > 1e-9),
        "a_better": sum(1 for d in deltas if d < -1e-9),
        "ties": sum(1 for d in deltas if abs(d) <= 1e-9),
    }
    return {"groups": groups, "paired": paired}


# --- reporting --------------------------------------------------------------------------------


def _fmt(value: Any, spec: str = ".1f") -> str:
    return "-" if value is None else format(value, spec)


_TABLE_COLUMNS: tuple[tuple[str, str, str], ...] = (
    ("n", "n", "d"),
    ("mean_score", "mean score", ".0f"),
    ("score_share_of_max", "% max", ".1%"),
    ("median_rank1_distance_m", "median d1 m", ".0f"),
    ("within_100m", "<=100m", ".0%"),
    ("within_1km", "<=1km", ".0%"),
    ("within_10km", "<=10km", ".0%"),
    ("mean_cost_usd", "mean $", ".2f"),
    ("total_cost_usd", "total $", ".2f"),
    ("mean_time_s", "mean s", ".0f"),
)


def format_table(summary: Mapping[str, Mapping[str, Any]]) -> str:
    header = ["group", *(title for _, title, _ in _TABLE_COLUMNS)]
    rows = [
        [group, *(_fmt(summary[group].get(key), spec) for key, _, spec in _TABLE_COLUMNS)]
        for group in GROUPS
        if group in summary
    ]
    widths = [max(len(row[i]) for row in [header, *rows]) for i in range(len(header))]
    lines = ["  ".join(cell.rjust(width) if i else cell.ljust(width) for i, (cell, width) in enumerate(zip(row, widths)))
             for row in [header, *rows]]
    return "\n".join(lines)


def format_comparison(comparison: Mapping[str, Any]) -> str:
    lines: list[str] = []
    for group, metrics in comparison["groups"].items():
        lines.append(f"[{group}]")
        for metric, row in metrics.items():
            lines.append(
                f"  {metric:<26} a={_fmt(row['a'], '.4g'):>10}  b={_fmt(row['b'], '.4g'):>10}  "
                f"delta={_fmt(row['delta'], '+.4g'):>10}"
            )
    paired = comparison["paired"]
    lines.append(
        f"paired over {paired['n']} panoramas: mean score delta (b - a) = {_fmt(paired['mean_score_delta'], '+.1f')}; "
        f"b better on {paired['b_better']}, a better on {paired['a_better']}, ties {paired['ties']}"
    )
    return "\n".join(lines)


def build_results(run_id: str, config: Mapping[str, Any], scores: Sequence[PanoScore]) -> dict[str, Any]:
    return {
        "run_id": run_id,
        "config": dict(config),
        "summary": summarise(scores),
        "panoramas": [asdict(s) for s in scores],
    }


def write_results(run_dir: Path, results: Mapping[str, Any], *, tag: str = "") -> tuple[Path, Path]:
    stem = f"results.{tag}" if tag else "results"
    json_path, csv_path = run_dir / f"{stem}.json", run_dir / f"{stem}.csv"
    json_path.write_text(json.dumps(results, indent=2) + "\n", encoding="utf-8")
    with csv_path.open("w", newline="", encoding="utf-8") as handle:
        writer = csv.DictWriter(handle, fieldnames=[f.name for f in fields(PanoScore)])
        writer.writeheader()
        writer.writerows(results["panoramas"])
    return json_path, csv_path


def load_exports(run_dir: Path) -> dict[str, dict[str, Any]]:
    """Per-panorama exports in a run directory, keyed by panorama_id; other JSON files are ignored."""
    exports: dict[str, dict[str, Any]] = {}
    for path in sorted(run_dir.glob("*.json")):
        try:
            doc = json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            continue
        if not isinstance(doc, dict) or "final" not in doc or "events" not in doc:
            continue
        panorama = doc.get("panorama") if isinstance(doc.get("panorama"), dict) else {}
        exports[str(panorama.get("panorama_id") or path.stem)] = doc
    return exports


# --- running the agent ------------------------------------------------------------------------


def disable_tools(names: Iterable[str]) -> list[str]:
    """Switch tools off for an ablation run; returns the names switched off.

    Settings has no per-tool flag, so this edits the process-wide tool tables: the tool leaves
    the definitions the model is sent, and its handler becomes a free error in case it is still
    called. Only meaningful in a process that exits after the run.
    """
    from geoagent.tools import registry, schemas
    from geoagent.tools.base import ToolContext, ToolResult

    off = {name.strip() for name in names if name.strip()}
    groups = (schemas.LOCAL_TOOLS, schemas.HUMAN_TOOLS, schemas.WEB_CLIENT_TOOLS)
    known = {tool["name"] for group in groups for tool in group} | SERVER_TOOL_NAMES
    if off - known:
        raise ValueError(f"unknown tools: {', '.join(sorted(off - known))}; known: {', '.join(sorted(known))}")
    if off & PROTECTED_TOOLS:
        raise ValueError(f"cannot disable {', '.join(sorted(off & PROTECTED_TOOLS))}: the answer path needs them")

    for group in groups:
        group[:] = [tool for tool in group if tool["name"] not in off]
    if off & SERVER_TOOL_NAMES:
        original = schemas.server_tools
        schemas.server_tools = lambda settings: [t for t in original(settings) if t["name"] not in off]

    async def disabled(ctx: ToolContext, args: dict[str, Any]) -> ToolResult:
        return ToolResult.error("This tool is switched off for this run. Continue without it.")

    for name in off & registry.HANDLERS.keys():
        registry.HANDLERS[name] = disabled
    return sorted(off)


def apply_leak_guards(sessions: Mapping[str, Any], truths: Mapping[str, Truth]) -> None:
    """Tell streetview_lookup which imagery is the panorama's own source, so it cannot be returned."""
    missing = sorted(set(truths) - set(sessions))
    if missing:
        raise RuntimeError(
            "RunManager has no session for " + ", ".join(missing) + " after add_tasks; refusing to run "
            "without the source-imagery exclusion (sessions must exist before start())."
        )
    for panorama_id, truth in truths.items():
        session = sessions[panorama_id]
        session.excluded_image_ids = {truth.source_image_id} if truth.source_image_id else set()
        # Neighbouring frames of the same drive are near-duplicates of the panorama beyond 25 m too.
        session.excluded_sequence_ids = {truth.sequence} if truth.sequence else set()
        session.excluded_point = (truth.lat, truth.lng)


async def drive(manager: Any, tasks: Sequence[PanoramaTask], truths: Mapping[str, Truth], concurrency: int | None) -> list[Path]:
    manager.add_tasks(list(tasks))
    apply_leak_guards(manager.sessions, {t.panorama_id: truths[t.panorama_id] for t in tasks})
    await manager.start(concurrency)
    return manager.export_all()


def eval_settings(*, effort: str | None, hedge: bool, allow_web: bool, runs_dir: Path | None) -> Any:
    from geoagent.config import load_settings

    settings = load_settings(no_human=True, hedge=hedge, allow_web=allow_web, runs_dir=runs_dir)
    if effort is None:
        return settings
    return settings.model_copy(
        update={
            "standard": settings.standard.model_copy(update={"effort": effort}),
            "special": settings.special.model_copy(update={"effort": effort}),
        }
    )


def _load_ground_truth(data: Path) -> tuple[list[dict[str, Any]], dict[str, Truth]]:
    manifest_path = data / MANIFEST_NAME
    if not manifest_path.exists():
        typer.echo(f"{manifest_path} not found; build the set with `python -m eval.build_set build`.", err=True)
        raise typer.Exit(code=2)
    entries = load_manifest(manifest_path)
    try:
        return entries, truths_from_manifest(entries)
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(code=2) from None


def _report(run_dir: Path, results: Mapping[str, Any], *, tag: str = "") -> None:
    json_path, csv_path = write_results(run_dir, results, tag=tag)
    typer.echo(format_table(results["summary"]))
    typer.echo(f"\n{json_path}\n{csv_path}")


app = typer.Typer(add_completion=False, help=__doc__)


@app.command()
def run(
    data: Path = typer.Option(DEFAULT_DATA_DIR, help="Directory with manifest.json and the images."),
    effort: str = typer.Option(None, help="Override the effort of both budgets (low|medium|high|xhigh|max)."),
    hedge: bool = typer.Option(False, "--hedge/--no-hedge", help="Allocator hedge setting."),
    web: bool = typer.Option(True, "--web/--no-web", help="ALLOW_WEB: --no-web switches every external tool off."),
    tools_off: str = typer.Option("", help="Comma-separated tool names to switch off (ablation)."),
    concurrency: int = typer.Option(None, min=1, help="Panoramas in parallel (default: settings.concurrency)."),
    limit: int = typer.Option(None, min=1, help="Only the first N panoramas of the manifest."),
    run_id: str = typer.Option(None, help="Run directory name under runs/ (default: generated)."),
    runs_dir: Path = typer.Option(None, help="Parent directory for runs (default: settings.runs_dir)."),
) -> None:
    """Run the agent over the eval set in --no-human mode and score it. Calls the Anthropic API."""
    from geoagent.runner import RunManager

    entries, truths = _load_ground_truth(data)
    tasks = tasks_from_manifest(entries[:limit] if limit else entries, data)
    unconfirmed = sum(1 for e in entries if not e.get("label_confirmed", True))
    if unconfirmed:
        typer.echo(f"warning: {unconfirmed} labels are unconfirmed guesses (see `eval.build_set label`).", err=True)
    try:
        switched_off = disable_tools(tools_off.split(","))
    except ValueError as exc:
        typer.echo(str(exc), err=True)
        raise typer.Exit(code=2) from None

    settings = eval_settings(effort=effort, hedge=hedge, allow_web=web, runs_dir=runs_dir)
    manager = RunManager(settings, run_id=run_id)
    asyncio.run(drive(manager, tasks, truths, concurrency))

    config = {
        "mode": "run",
        "model": settings.model,
        "effort": {"standard": settings.standard.effort, "special": settings.special.effort},
        "hedge": settings.hedge,
        "allow_duplicates": settings.allow_duplicates,
        "allow_web": settings.allow_web,
        "tools_off": switched_off,
        "manifest": str(data / MANIFEST_NAME),
        "panoramas": len(tasks),
    }
    run_dir = Path(manager.run_dir)
    scores = score_run(load_exports(run_dir), truths)
    if len(scores) < len(tasks):
        typer.echo(f"warning: {len(tasks) - len(scores)} panoramas have no export in {run_dir}.", err=True)
    _report(run_dir, build_results(manager.run_id, config, scores))


@app.command()
def rescore(
    run_dir: Path = typer.Argument(..., help="Run directory holding the per-panorama exports."),
    data: Path = typer.Option(DEFAULT_DATA_DIR, help="Directory with manifest.json (ground truth)."),
    hedge: bool = typer.Option(None, "--hedge/--no-hedge", help="Re-allocate the logged hypotheses with this hedge setting."),
    duplicates: bool = typer.Option(True, "--duplicates/--distinct", help="ALLOW_DUPLICATES for the re-allocation."),
    tag: str = typer.Option(None, help="Output suffix: results.<tag>.json (default: derived from the flags)."),
) -> None:
    """Recompute the metrics from existing exports, optionally under other allocator settings. Offline."""
    _, truths = _load_ground_truth(data)
    exports = load_exports(run_dir)
    if not exports:
        typer.echo(f"No panorama exports in {run_dir}.", err=True)
        raise typer.Exit(code=2)
    reallocating = hedge is not None or not duplicates
    scores = score_run(
        exports, truths, hedge=(bool(hedge) if reallocating else None), allow_duplicates=duplicates
    )
    if not scores:
        typer.echo(f"None of the {len(exports)} exports in {run_dir} match a panorama_id in the manifest.", err=True)
        raise typer.Exit(code=2)
    config = {
        "mode": "rescore",
        "reallocated": reallocating,
        "hedge": bool(hedge) if reallocating else None,
        "allow_duplicates": duplicates if reallocating else None,
        "manifest": str(data / MANIFEST_NAME),
        "panoramas": len(scores),
    }
    if tag is None:
        tag = "rescore" if not reallocating else ("hedge" if hedge else "nohedge") + ("" if duplicates else "-distinct")
    _report(run_dir, build_results(run_dir.name, config, scores), tag=tag)


@app.command()
def compare(
    a: Path = typer.Argument(..., help="Baseline results.json."),
    b: Path = typer.Argument(..., help="Candidate results.json."),
) -> None:
    """Compare two results.json files: metric deltas per group and paired per-panorama scores."""
    results_a = json.loads(a.read_text(encoding="utf-8"))
    results_b = json.loads(b.read_text(encoding="utf-8"))
    typer.echo(f"a = {a}\nb = {b}")
    typer.echo(format_comparison(compare_results(results_a, results_b)))


if __name__ == "__main__":
    app()
