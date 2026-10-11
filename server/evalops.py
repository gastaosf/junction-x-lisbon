"""Evaluation behind the console (UI-SPEC 5.9): the set in the evaluation data directory and its
build job, the launch form of an eval run, and results, rescoring, comparison and ground truth.

Everything that is measured against ground truth is computed by eval.run_eval; this module only
reads and writes the files around it, so console results compare with CLI ones. Truth-derived
data leaves through `gated` alone (security.truth_allowed): an evaluation run with its human
channels off.

Threading: functions that take a workspace are for the loop thread (the `async` ones push their
file work to a thread themselves); the rest are blocking and belong in `asyncio.to_thread`.
What is raised: ConsoleError (HTTP status and detail), KeyError for an unknown run or panorama
(404), ValueError from safe_id / safe_tag for a value that cannot be a name (400).
"""

from __future__ import annotations

import asyncio
import json
import os
import secrets
import tempfile
import threading
from collections import Counter
from collections.abc import Iterable, Mapping
from pathlib import Path
from typing import TYPE_CHECKING, Any

from eval import build_set
from eval.build_set import MANIFEST_NAME, TODO_LABEL, load_manifest, save_manifest
from eval.run_eval import (
    THRESHOLDS_M,
    PanoScore,
    Truth,
    build_results,
    compare_results,
    final_locations,
    load_exports,
    reallocate,
    rescore_config,
    rescore_tag,
    score_export,
    score_run,
    truths_from_manifest,
    write_results,
)
from astrolabio.schema import Label
from astrolabio.scoring import haversine_m, theta

from .jobs import ACTIVE_STATES, Job
from .security import TAG_RE, confine, safe_id, safe_tag, truth_allowed
from .sets import ConsoleError, preview_image
from .store import SettingsError
from .words import count as counted
from .words import listed, plural

if TYPE_CHECKING:
    from .workspace import Workspace

BUILD_KIND = "eval_build"
LABELS: tuple[str, ...] = (Label.URBAN.value, Label.NON_URBAN.value)
# Sets built before the opaque ids carry the Mapillary image key in the id the agent is shown.
LEAKING_PREFIX = "mly_"
# Distance bands of the truth map: the thresholds of the results table, by their short names.
BANDS: tuple[tuple[str, float], ...] = tuple((name.removeprefix("within_"), limit) for name, limit in THRESHOLDS_M)
FAR_BAND = "far"

_ENTRY_FIELDS = (
    "panorama_id",
    "filename",
    "label",
    "label_confirmed",
    "lat",
    "lng",
    "area",
    "country",
    "kind",
    "timestamp",
)
_RUN_KEYS = ("effort", "hedge", "web", "tools_off", "limit", "concurrency", "run_id", "confirm_no_key")
# form field -> launch setting
_RUN_SETTINGS = (
    ("hedge", "hedge"),
    ("web", "allow_web"),
    ("tools_off", "disabled_tools"),
    ("concurrency", "concurrency"),
)
_RESCORE_KEYS = ("hedge", "duplicates", "tag")
# count, seed and per_area_limit as the build command bounds them: (lowest, highest, default)
_BUILD_NUMBERS: dict[str, tuple[int, int, int]] = {
    "count": (1, 50, 40),
    "seed": (-(2**31), 2**31 - 1, 0),
    "per_area_limit": (1, 2000, 100),
}

# Label edits are read-modify-write of the whole manifest and a build replaces it: one at a time.
_manifest_lock = threading.Lock()


def _unknown_keys(body: Any, allowed: Iterable[str], what: str) -> None:
    if not isinstance(body, Mapping):
        raise ConsoleError(422, f"The {what} must be an object.", code="invalid_request")
    unknown = sorted(str(key) for key in body if key not in allowed)
    if unknown:
        raise ConsoleError(
            422,
            f"Unknown {what} {plural(len(unknown), 'field')}: {', '.join(unknown)}.",
            code="unknown_field",
            problems=unknown,
        )


def _json_file(path: Path) -> dict[str, Any]:
    try:
        doc = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, ValueError):
        return {}
    return doc if isinstance(doc, dict) else {}


# ---------------------------------------------------------------------------------------------
# the set


def write_manifest(path: Path, entries: list[dict[str, Any]]) -> None:
    """Replace the manifest in one step, so a reader never sees half of it. Hold `_manifest_lock`."""
    tmp = path.with_name(f".{path.name}.{secrets.token_hex(4)}.tmp")
    try:
        save_manifest(tmp, entries)
        os.replace(tmp, path)
    finally:
        tmp.unlink(missing_ok=True)


def _read_manifest(data_dir: Path) -> list[Any] | None:
    """The manifest as it is stored, or None when there is no set yet."""
    path = data_dir / MANIFEST_NAME
    try:
        return load_manifest(path)
    except FileNotFoundError:
        return None
    except (OSError, ValueError) as exc:
        raise ConsoleError(
            409,
            f"The evaluation manifest {path} cannot be read ({type(exc).__name__}). Rebuild the set, or repair "
            "the file by hand.",
            code="invalid_eval_set",
        ) from exc


def _panoramas(stored: list[Any] | None) -> list[dict[str, Any]]:
    return [entry for entry in stored or [] if isinstance(entry, dict) and entry.get("panorama_id")]


def _label(entry: Mapping[str, Any]) -> str:
    """The entry's label as the launch reads it: Urban, non-Urban, or TODO for anything else."""
    try:
        return Label.parse(str(entry.get("label", ""))).value
    except ValueError:
        return TODO_LABEL


def _confirmed(entry: Mapping[str, Any]) -> bool:
    # a hand-written manifest has no such field: its labels are the author's, as the CLI reads it
    return _label(entry) != TODO_LABEL and bool(entry.get("label_confirmed", True))


def _counts(entries: list[dict[str, Any]]) -> dict[str, Any]:
    """The three label states are disjoint: `unconfirmed` is a usable guess nobody has confirmed."""
    labels = Counter(_label(entry) for entry in entries)
    confirmed = sum(1 for entry in entries if _confirmed(entry))
    return {
        "count": len(entries),
        "confirmed": confirmed,
        "unconfirmed": len(entries) - confirmed - labels[TODO_LABEL],
        "todo": labels[TODO_LABEL],
        "by_label": {name: labels[name] for name in (*LABELS, TODO_LABEL)},
    }


def _public(entry: Mapping[str, Any]) -> dict[str, Any]:
    shown = {key: entry.get(key) for key in _ENTRY_FIELDS}
    shown.update(panorama_id=str(entry["panorama_id"]), label=_label(entry), label_confirmed=_confirmed(entry))
    return shown


def set_state(data_dir: Path) -> dict[str, Any]:
    """Blocking. What the Set tab shows. With coordinates: only the /eval screen may ask."""
    problem = None
    try:
        stored = _read_manifest(data_dir)
    except ConsoleError as exc:
        stored, problem = [], exc.message
    entries = _panoramas(stored)
    return {
        "exists": stored is not None,
        "data_dir": str(data_dir),
        **_counts(entries),
        "by_country": dict(Counter(str(entry.get("country") or "") for entry in entries)),
        "by_kind": dict(Counter(str(entry.get("kind") or "") for entry in entries)),
        "leaking": [str(e["panorama_id"]) for e in entries if str(e["panorama_id"]).startswith(LEAKING_PREFIX)],
        "missing": [str(e["panorama_id"]) for e in entries if not (data_dir / str(e.get("filename") or "")).is_file()],
        "problem": problem,
        "entries": [_public(entry) for entry in entries],
    }


def set_label(data_dir: Path, panorama_id: str, label: Any, *, frozen: bool = False) -> dict[str, Any]:
    """Blocking. Confirm one label by hand; returns `{entry, counts}`. With `frozen` (an eval run
    is going) the label may be confirmed as it is but not changed: the run was launched with it."""
    pid = safe_id(panorama_id, "panorama id")
    if label not in LABELS:
        raise ConsoleError(422, f"label must be exactly {LABELS[0]} or {LABELS[1]}.", code="invalid_label")
    with _manifest_lock:
        stored = _read_manifest(data_dir)
        entries = _panoramas(stored)
        entry = next((e for e in entries if e["panorama_id"] == pid), None)
        if stored is None or entry is None:
            raise KeyError(pid)
        if frozen and _label(entry) != label:
            raise ConsoleError(
                409,
                f"An evaluation run is going and was launched with {pid} as {_label(entry)}. Change the label "
                "when the run has ended.",
                code="eval_run_active",
            )
        build_set.set_label([entry], pid, label)
        write_manifest(data_dir / MANIFEST_NAME, stored)
    return {"entry": _public(entry), "counts": _counts(entries)}


def set_image(data_dir: Path, cache_dir: Path, panorama_id: str, width: int | str | None) -> tuple[Path, str]:
    """Blocking. (file, media type) of one evaluation panorama for the labelling viewer."""
    pid = safe_id(panorama_id, "panorama id")
    entry = next((e for e in _panoramas(_read_manifest(data_dir)) if e["panorama_id"] == pid), None)
    if entry is None:
        raise KeyError(pid)
    try:
        # the file name comes from a file on disk: it must not lead out of the set
        source = confine(data_dir / str(entry.get("filename") or pid), data_dir)
    except FileNotFoundError:
        raise ConsoleError(
            404, f"The image of {pid} is missing from the evaluation set.", code="image_missing"
        ) from None
    except PermissionError:
        raise ConsoleError(
            403, f"The manifest names a file outside the evaluation set for {pid}.", code="outside_eval_set"
        ) from None
    return preview_image(source, cache_dir, width)


def active_eval_runs(ws: Workspace) -> list[str]:
    return [handle.run_id for handle in ws.handles.values() if handle.kind == "eval" and handle.active]


def build_job(ws: Workspace) -> Job | None:
    """The build that is running now, if any."""
    return ws.jobs.find(BUILD_KIND, ACTIVE_STATES)


def refuse_during_build(ws: Workspace, what: str) -> None:
    if build_job(ws) is not None:
        raise ConsoleError(
            409,
            f"The evaluation set is being built. {what} when the build has ended.",
            code="build_running",
        )


def _build_options(body: Any) -> dict[str, Any]:
    _unknown_keys(body, (*_BUILD_NUMBERS, "replace"), "build request")
    options: dict[str, Any] = {}
    problems = []
    for key, (low, high, default) in _BUILD_NUMBERS.items():
        value = body.get(key, default)
        if isinstance(value, bool) or not isinstance(value, int) or not low <= value <= high:
            problems.append(f"{key} must be a whole number from {low} to {high}")
        options[key] = value
    options["replace"] = body.get("replace", False)
    if not isinstance(options["replace"], bool):
        problems.append("replace must be true or false")
    if problems:
        raise ConsoleError(422, "; ".join(problems) + ".", code="invalid_build", problems=problems)
    return options


def start_build(ws: Workspace, body: Any) -> Job:
    """Loop thread. Start the build job (`eval.build_set build`), or say why it cannot start."""
    options = _build_options(body)
    data_dir = ws.eval_data_dir
    refuse_during_build(ws, "Start another one")
    token = os.environ.get("MAPILLARY_TOKEN")
    if not token:
        raise ConsoleError(
            409,
            "MAPILLARY_TOKEN is not set, and the panoramas of the evaluation set come from Mapillary. Create "
            "a free client token at mapillary.com/dashboard/developers and save it in Settings.",
            code="mapillary_token_missing",
            action="settings",
        )
    if (data_dir / MANIFEST_NAME).exists() and not options["replace"]:
        raise ConsoleError(
            409,
            "There is already an evaluation set. Replacing it loses every label confirmed by hand; confirm to "
            "replace it.",
            code="set_exists",
            action="replace",
        )
    running = active_eval_runs(ws)
    if running:
        # the run is scored against the manifest its leak guards were built from
        raise ConsoleError(
            409,
            f"Evaluation {plural(len(running), 'run')} {listed(running)} {plural(len(running), 'is')} going and "
            f"{plural(len(running), 'reads', 'read')} this set. Build when "
            f"{'it has' if len(running) == 1 else 'they have'} ended.",
            code="eval_run_active",
        )

    def work(job: Job) -> dict[str, Any]:
        count = options["count"]
        entries = build_set.build_set(
            count,
            options["seed"],
            data_dir,
            options["per_area_limit"],
            options["replace"],
            token=token,
            progress=job.progress,
            log=job.log,
        )
        if not entries:
            raise RuntimeError("no panorama could be downloaded; an existing set is left as it was")
        with _manifest_lock:
            write_manifest(data_dir / MANIFEST_NAME, entries)
        todo = sum(1 for entry in entries if _label(entry) == TODO_LABEL)
        job.log(f"Wrote {counted(len(entries), 'panorama')} ({todo} labelled {TODO_LABEL}, none confirmed).")
        if len(entries) < count:
            # (fewer than asked and more than none: `count` is at least 2 here)
            job.log(f"Only {len(entries)} of {count} requested panoramas {plural(len(entries), 'was')} available.")
        job.progress(len(entries), count, "done")
        return {"count": len(entries), "requested": count, "todo": todo, "manifest": str(data_dir / MANIFEST_NAME)}

    return ws.jobs.start(BUILD_KIND, "Build the evaluation set", work)


# ---------------------------------------------------------------------------------------------
# launching a run


def launch_spec(body: Any) -> dict[str, Any]:
    """The form of the Run tab as a LaunchSpec. A translation only: `Workspace.launch` checks the
    values, refuses TODO labels, forces the human channels off and applies the leak guards."""
    _unknown_keys(body, _RUN_KEYS, "evaluation run")
    settings: dict[str, Any] = {key: body[name] for name, key in _RUN_SETTINGS if body.get(name) is not None}
    if body.get("effort") is not None:
        settings["standard"] = {"effort": body["effort"]}
        settings["special"] = {"effort": body["effort"]}
    spec: dict[str, Any] = {"preset": "eval", "settings": settings, "eval": {"limit": body.get("limit")}}
    for key in ("run_id", "confirm_no_key"):
        if body.get(key) is not None:
            spec[key] = body[key]
    return spec


async def launch(ws: Workspace, body: Any) -> dict[str, Any]:
    spec = launch_spec(body)
    refuse_during_build(ws, "Launch")
    return await ws.launch(spec)


async def estimate(ws: Workspace, body: Any) -> dict[str, Any]:
    """What launching this form would run and may cost at most; nothing is created. A form that
    is itself wrong is a 422 as at launch; what the set lacks is listed in `blocking`.
    `todo_labels` counts the whole set (any one refuses the launch), `unconfirmed_labels` the
    panoramas that would run."""
    spec = launch_spec(body)
    try:
        settings = ws.build_settings({**spec["settings"], "no_human": True})
    except SettingsError as exc:
        raise ConsoleError(422, "; ".join(exc.problems), code=exc.code, problems=list(exc.problems)) from exc
    limit = spec["eval"]["limit"]
    if limit is not None and (isinstance(limit, bool) or not isinstance(limit, int) or limit < 1):
        raise ConsoleError(422, "limit must be a whole number above 0, or null.", code="invalid_limit")
    run_id = spec.get("run_id")
    if run_id is not None:
        try:
            safe_id(run_id, "run id")
        except ValueError as exc:
            raise ConsoleError(422, str(exc), code="invalid_run_id") from exc
    data_dir, runs_dir = ws.eval_data_dir, ws.runs_dir

    def read() -> dict[str, Any]:
        blocking: list[str] = []
        stored = _read_manifest(data_dir)
        entries = _panoramas(stored)
        chosen = entries[:limit] if limit else entries
        todo = sum(1 for entry in entries if _label(entry) == TODO_LABEL)
        if stored is None:
            blocking.append("There is no evaluation set yet. Build one on the Set tab.")
        elif not chosen:
            blocking.append("The evaluation set is empty. Build it again.")
        if todo:
            blocking.append(
                f"{counted(todo, 'panorama')} still {plural(todo, 'has')} no Urban / non-Urban label. "
                f"Label {'it' if todo == 1 else 'them'} first."
            )
        missing = [str(e["panorama_id"]) for e in chosen if not (data_dir / str(e.get("filename") or "")).is_file()]
        if missing:
            blocking.append(
                f"The {plural(len(missing), 'image')} of {listed(missing)} {plural(len(missing), 'is')} missing "
                "from the set. Build it again."
            )
        if run_id is not None and (runs_dir / run_id).is_dir() and any((runs_dir / run_id).iterdir()):
            blocking.append(f"Run id {run_id} is taken; an evaluation run needs a directory of its own.")
        ceiling = sum(settings.budget_for(bool(e.get("special", False))).max_spend_usd for e in chosen)
        return {
            "panoramas": len(chosen),
            "cost_ceiling_usd": round(ceiling, 2),
            "todo_labels": todo,
            "unconfirmed_labels": _counts(chosen)["unconfirmed"],
            "blocking": blocking,
        }

    try:
        result = await asyncio.to_thread(read)
    except ConsoleError as exc:  # a manifest that cannot be read blocks the launch; it is not a bad form
        result = {
            "panoramas": 0,
            "cost_ceiling_usd": 0.0,
            "todo_labels": 0,
            "unconfirmed_labels": 0,
            "blocking": [exc.message],
        }
    if build_job(ws) is not None:
        result["blocking"].append("The evaluation set is being built. Launch when the build has ended.")
    return result


# ---------------------------------------------------------------------------------------------
# scoring


def _truths(manifest_path: Path, panorama_ids: Iterable[str]) -> dict[str, Truth]:
    """Ground truth of these panoramas only: a label still TODO elsewhere in the set (after a
    rebuild, say) must not stop a run that never held that panorama from being scored."""
    try:
        entries = load_manifest(manifest_path)
    except (OSError, ValueError) as exc:
        raise ConsoleError(
            409,
            f"The evaluation manifest this run is scored against ({manifest_path}) cannot be read.",
            code="no_eval_set",
        ) from exc
    wanted = set(panorama_ids)
    try:
        return truths_from_manifest(e for e in entries if isinstance(e, dict) and str(e.get("panorama_id")) in wanted)
    except (KeyError, TypeError, ValueError) as exc:
        raise ConsoleError(409, f"The evaluation manifest cannot be used: {exc}", code="invalid_eval_set") from exc


def _scores(
    run_dir: Path, manifest_path: Path, *, hedge: bool | None = None, duplicates: bool = True
) -> list[PanoScore]:
    exports = load_exports(run_dir)
    if not exports:
        raise ConsoleError(
            409,
            f"Run {run_dir.name} has no exports to score. Rebuild its exports first.",
            code="no_exports",
            action="rebuild",
        )
    scores = score_run(exports, _truths(manifest_path, exports), hedge=hedge, allow_duplicates=duplicates)
    if not scores:
        raise ConsoleError(
            409,
            f"None of the panoramas of run {run_dir.name} is in {manifest_path}: the evaluation set was "
            "replaced since the run, so it can no longer be scored.",
            code="set_changed",
        )
    return scores


def _results_path(run_dir: Path, tag: str) -> Path:
    """results.json, or results.<tag>.json of a rescore variant, inside the run directory."""
    name = f"results.{safe_tag(tag)}.json" if tag else "results.json"
    return confine(run_dir / name, run_dir, strict=False)


def _write(run_dir: Path, results: Mapping[str, Any], tag: str = "") -> None:
    """results[.<tag>].json and .csv, each replaced in one step: the page reads them while a
    rescore or the end-of-run scoring writes."""
    _results_path(run_dir, tag)
    with tempfile.TemporaryDirectory(dir=run_dir, prefix=".results-") as tmp:
        for path in write_results(Path(tmp), results, tag=tag):
            os.replace(path, run_dir / path.name)


def score_run_dir(run_dir: Path, manifest_path: Path, config: dict[str, Any]) -> dict[str, Any]:
    """Blocking. Score a run's exports against the manifest and write results.json and .csv, as
    `eval.run_eval run` does after its run. `config` is stored as given. Returns the results."""
    run_dir = Path(run_dir)
    results = build_results(run_dir.name, config, _scores(run_dir, Path(manifest_path)))
    _write(run_dir, results)
    return results


def manifest_of(run_dir: Path, meta: Mapping[str, Any] | None, default: Path) -> Path:
    """The manifest a run was launched from (run.json), or scored against by the CLI (results.json)."""
    named = ((meta or {}).get("eval") or {}).get("manifest")
    named = named or (_json_file(run_dir / "results.json").get("config") or {}).get("manifest")
    return Path(named) if isinstance(named, str) and named else default


def _results_doc(run_dir: Path, tag: str) -> dict[str, Any]:
    doc = _json_file(_results_path(run_dir, tag))
    if "summary" not in doc:
        which = f"no rescore variant {tag!r}" if tag else "no results yet"
        raise ConsoleError(
            404,
            f"Run {run_dir.name} has {which}. Results are written when an evaluation run ends, and by "
            "Rescore.",
            code="no_results",
        )
    return doc


def _variants(run_dir: Path) -> list[dict[str, Any]]:
    variants = []
    for path in sorted(run_dir.glob("results.*.json")):
        tag = path.name[len("results.") : -len(".json")]
        doc = _json_file(path) if TAG_RE.match(tag) else {}
        if "summary" in doc:
            variants.append({"tag": tag, "summary": doc["summary"], "config": doc.get("config") or {}})
    return variants


def results(run_dir: Path, tag: str = "") -> dict[str, Any]:
    """Blocking. The results of a run, or of its rescore variant `tag`, with every variant listed
    beside them. `config` is always the run's own: what produced the answers being rescored."""
    original = _results_doc(run_dir, "")
    return {
        "run_id": run_dir.name,
        "tag": tag,
        "results": _results_doc(run_dir, tag) if tag else original,
        "variants": _variants(run_dir),
        "config": original.get("config") or {},
        # the run's own numbers, also when a variant was asked for: every variant is measured
        # against them, and the page should not need a second request to show that
        "original": {"summary": original["summary"], "config": original.get("config") or {}},
    }


def rescore_options(body: Any) -> tuple[bool | None, bool, str]:
    """(hedge, duplicates, tag) of a rescore request. No tag: one derived from the options, as the
    CLI derives it. The empty tag rewrites results.json itself and so takes no other option."""
    _unknown_keys(body, _RESCORE_KEYS, "rescore request")
    hedge, duplicates, tag = body.get("hedge"), body.get("duplicates", True), body.get("tag")
    if (hedge is not None and not isinstance(hedge, bool)) or not isinstance(duplicates, bool):
        raise ConsoleError(
            422, "hedge must be true, false or null, and duplicates true or false.", code="invalid_rescore"
        )
    if tag is None:
        tag = rescore_tag(hedge, duplicates)
    elif tag == "":
        if hedge is not None or not duplicates:
            raise ConsoleError(
                422,
                "The empty tag rewrites results.json, which holds the answers as the run gave them: send hedge "
                "null and duplicates true with it, or name the variant.",
                code="invalid_tag",
            )
    else:
        try:
            safe_tag(tag)
        except ValueError as exc:
            raise ConsoleError(422, str(exc), code="invalid_tag") from exc
    return hedge, duplicates, tag


def rescore(
    run_dir: Path,
    manifest_path: Path,
    *,
    hedge: bool | None,
    duplicates: bool,
    tag: str,
    meta: Mapping[str, Any] | None = None,
    run_config: Mapping[str, Any] | None = None,
) -> dict[str, Any]:
    """Blocking, offline. Recompute the metrics from the exports, re-allocating the logged
    hypotheses when `hedge` is set or `duplicates` is off, and write results.<tag>.json (the
    empty tag: results.json, with the run's own config; `run_config` is that config for a run
    that was never scored, as `Workspace.eval_config` builds it). Returns `{tag, results}`."""
    meta = meta or {}
    reallocating = hedge is not None or not duplicates
    scores = _scores(
        run_dir, manifest_path, hedge=(bool(hedge) if reallocating else None), duplicates=duplicates
    )
    original = _json_file(run_dir / "results.json").get("config")
    if tag:
        config: dict[str, Any] = {
            **rescore_config(hedge, duplicates, manifest_path, len(scores)),
            "fake_model": bool(meta.get("fake_model") or (original or {}).get("fake_model")),
        }
    elif isinstance(original, dict) and original.get("mode") == "run":
        config = original
    else:
        config = {**(run_config or {"mode": "run"}), "manifest": str(manifest_path)}
        config["panoramas"] = config.get("panoramas") or len(scores)  # a run.json without its tasks
    doc = build_results(run_dir.name, config, scores)
    _write(run_dir, doc, tag)
    return {"tag": tag, "results": doc}


# ---------------------------------------------------------------------------------------------
# compare


def split_ref(ref: Any) -> tuple[str, str]:
    """`run_id[:tag]` of the compare query as (run id, tag); ValueError for a name that is unsafe."""
    if not isinstance(ref, str) or not ref:
        raise ValueError("Name both sides to compare: a=<run id>[:tag] and b=<run id>[:tag]")
    run_id, _, tag = ref.partition(":")
    return safe_id(run_id, "run id"), safe_tag(tag) if tag else ""


def _side(run_dir: Path, tag: str, meta: Mapping[str, Any] | None) -> tuple[dict[str, Any], dict[str, Any]]:
    doc = _results_doc(run_dir, tag)
    config = doc.get("config") or {}
    own = config if not tag else _json_file(run_dir / "results.json").get("config") or {}
    fake = bool((meta or {}).get("fake_model") or own.get("fake_model") or config.get("fake_model"))
    return doc, {"run_id": run_dir.name, "tag": tag, "config": config, "fake_model": fake}


def compare(
    a: tuple[Path, str, Mapping[str, Any] | None], b: tuple[Path, str, Mapping[str, Any] | None]
) -> dict[str, Any]:
    """Blocking. Two result files, each (run directory, tag, run.json): metric deltas per group,
    the paired count, and every panorama with both scores, the largest change first."""
    doc_a, side_a = _side(*a)
    doc_b, side_b = _side(*b)
    if side_a["fake_model"] != side_b["fake_model"]:
        raise ConsoleError(
            409,
            "One of these was answered by the scripted demo model and the other by a real one: comparing "
            "them says nothing.",
            code="fake_model_mismatch",
        )
    rows_a = {str(p["panorama_id"]): p for p in doc_a.get("panoramas") or []}
    rows_b = {str(p["panorama_id"]): p for p in doc_b.get("panoramas") or []}
    panoramas = []
    for pid in sorted(rows_a.keys() | rows_b.keys()):
        score_a, score_b = rows_a.get(pid, {}).get("score"), rows_b.get(pid, {}).get("score")
        paired = score_a is not None and score_b is not None
        panoramas.append(
            {
                "panorama_id": pid,
                "label": (rows_a.get(pid) or rows_b[pid]).get("label"),
                "score_a": score_a,
                "score_b": score_b,
                "delta": score_b - score_a if paired else None,
            }
        )
    # a panorama only one side holds has no change to rank: it goes last
    panoramas.sort(key=lambda row: (row["delta"] is None, -abs(row["delta"] or 0.0)))
    return {"a": side_a, "b": side_b, "comparison": compare_results(doc_a, doc_b), "panoramas": panoramas}


# ---------------------------------------------------------------------------------------------
# ground truth


def band(rank1_distance_m: float | None) -> str:
    """The distance band of an answer, by its rank-1 distance; no answer is as far as it gets."""
    if rank1_distance_m is None:
        return FAR_BAND
    return next((name for name, limit in BANDS if rank1_distance_m <= limit), FAR_BAND)


def _is_number(value: Any) -> bool:
    return isinstance(value, (int, float)) and not isinstance(value, bool)


def _top_distance_series(doc: Mapping[str, Any], truth: Truth) -> list[dict[str, Any]]:
    """How far the agent's most probable hypothesis was from the truth at each update."""
    series = []
    for event in doc.get("events") or []:
        if event.get("type") != "candidates_update":
            continue
        raw = (event.get("data") or {}).get("hypotheses") or []
        placed = [h for h in raw if isinstance(h, dict) and _is_number(h.get("lat")) and _is_number(h.get("lng"))]
        if not placed:
            continue
        top = max(placed, key=lambda h: h.get("probability") if _is_number(h.get("probability")) else 0.0)
        distance = haversine_m(top["lat"], top["lng"], truth.lat, truth.lng)
        series.append({"seq": event.get("seq"), "t_rel_s": event.get("t_rel_s"), "distance_m": round(distance, 1)})
    return series


def truth(run_dir: Path, manifest_path: Path, tag: str = "") -> dict[str, Any]:
    """Blocking. Truth against answer for every exported panorama of a run. With `tag`, the
    answer is the list that variant scored: PanoScore holds no points, so it is re-allocated
    from the logged hypotheses under the variant's config."""
    hedge, duplicates = None, True
    if tag:
        config = _results_doc(run_dir, tag).get("config") or {}
        if config.get("mode") == "rescore" and config.get("reallocated"):
            hedge, duplicates = bool(config.get("hedge")), config.get("allow_duplicates") is not False
    exports = load_exports(run_dir)
    truths = _truths(manifest_path, exports) if exports else {}
    panoramas: dict[str, dict[str, Any]] = {}
    for pid in sorted(exports):
        known = truths.get(pid)
        if known is None:
            continue
        doc = exports[pid]
        rebuilt = None if hedge is None else reallocate(doc, known.label, hedge=hedge, allow_duplicates=duplicates)
        locations = final_locations(doc) if rebuilt is None else rebuilt[0]
        scored = score_export(pid, doc, known, locations=locations)
        entries = []
        for rank, location in enumerate(locations, start=1):
            lat, lng = float(location["lat"]), float(location["lng"])
            distance = haversine_m(lat, lng, known.lat, known.lng)
            entries.append(
                {
                    "rank": location.get("rank", rank),
                    "lat": lat,
                    "lng": lng,
                    "distance_m": round(distance, 1),
                    "theta": round(theta(distance, known.label), 6),
                }
            )
        nearest = scored.rank1_distance_m
        panoramas[pid] = {
            "lat": known.lat,
            "lng": known.lng,
            "label": known.label.value,
            "entries": entries,
            "rank1_distance_m": None if nearest is None else round(nearest, 1),
            "score": round(scored.score, 2),
            "max_score": round(scored.max_score, 2),
            "share": round(scored.score / scored.max_score, 6) if scored.max_score else None,
            "band": band(nearest),
            "top_distance_series": _top_distance_series(doc, known),
        }
    return {"run_id": run_dir.name, "tag": tag, "panoramas": panoramas}


# ---------------------------------------------------------------------------------------------
# the gate


async def gated(ws: Workspace, run_id: str, *, settled: bool = False) -> tuple[Path, dict[str, Any]]:
    """(run directory, run.json) of a run whose truth-derived numbers may be shown; 403 for any
    other. With `settled`, 409 while the run is still going (its exports are not all written)."""
    from .workspace import read_meta  # the workspace imports this module when it scores

    run_dir = ws.run_dir(run_id)
    state = await ws.get_run(run_id)
    handle = ws.owned(run_id)
    meta = handle.meta if handle is not None else await asyncio.to_thread(read_meta, run_dir)
    # a CLI evaluation run has no run.json: the index recognised it by its results
    meta = {**(meta or {}), "kind": state["kind"]}
    if not await asyncio.to_thread(truth_allowed, meta, run_dir):
        raise ConsoleError(
            403,
            "Scores, distances and ground truth are shown only for an evaluation run whose human channels "
            "were off.",
            code="truth_not_allowed",
        )
    if settled and state["state"] in {"queued", "running"}:
        raise ConsoleError(
            409, f"Run {run_id} is still going. Rescore it when it has ended.", code="run_active"
        )
    return run_dir, meta
