"""Command line entry point: run <pano> | batch <dir> | export <run_dir> | eval ... | serve [<dir>]."""

from __future__ import annotations

import asyncio
import os
import signal
from pathlib import Path
from typing import Any, Optional

import typer

from geoagent.config import Settings, load_settings
from geoagent.runner import RunManager, describe_tasks, export_run, load_tasks
from geoagent.schema import Label

app = typer.Typer(add_completion=False, no_args_is_help=True, help=__doc__)

_TABLE_COLUMNS = ("panorama", "label", "special", "lat", "lng", "multiplier", "turns", "cost_usd", "wall_time_s", "stop_reason")

LabelOption = typer.Option(None, "--label", help="Label for panoramas whose label cannot be found (Urban | non-Urban).")
HedgeOption = typer.Option(False, "--hedge", help="Split the list between the top two hypotheses when they are close.")
NoWebOption = typer.Option(False, "--no-web", help="ALLOW_WEB=false: switch every external tool off.")
LiveOption = typer.Option(False, "--live", help="On-stage budget: a few minutes per panorama.")
RunIdOption = typer.Option(None, "--run-id", help="Run directory name under runs/ (default: UTC timestamp).")


def _settings(*, no_human: bool, hedge: bool, no_web: bool) -> Settings:
    # None leaves the environment's value in place; a flag can only switch a feature on/off one way.
    return load_settings(
        no_human=True if no_human else None,
        hedge=True if hedge else None,
        allow_web=False if no_web else None,
    )


def _parse_label(raw: Optional[str]) -> Label | None:
    if raw is None:
        return None
    try:
        return Label.parse(raw)
    except ValueError as exc:
        raise typer.BadParameter(str(exc), param_hint="--label") from None


def _load(path: Path, special: Optional[str], label: Optional[str]) -> list[Any]:
    warnings: list[str] = []
    try:
        tasks = load_tasks(path, special=special, default_label=_parse_label(label), warnings=warnings)
    except (ValueError, FileNotFoundError) as exc:
        typer.echo(f"error: {exc}", err=True)
        raise typer.Exit(code=2) from None
    # A wrong label or Special One flag is silent later on; show what was parsed before launch.
    for line in describe_tasks(tasks):
        typer.echo(line)
    for warning in warnings:
        typer.echo(f"warning: {warning}", err=True)
    return tasks


def _cell(value: Any) -> str:
    if value is None:
        return "-"
    return f"{value:.6f}".rstrip("0").rstrip(".") if isinstance(value, float) else str(value)


def _print_summary(rows: list[dict[str, Any]], paths: list[Path]) -> None:
    table = [_TABLE_COLUMNS, *([_cell(row.get(c)) for c in _TABLE_COLUMNS] for row in rows)]
    widths = [max(len(line[i]) for line in table) for i in range(len(_TABLE_COLUMNS))]
    for line in table:
        typer.echo("  ".join(cell.ljust(width) for cell, width in zip(line, widths)).rstrip())
    for row in rows:
        if row.get("problems"):
            typer.echo(f"INVALID EXPORT {row['panorama']}: {row['problems']}", err=True)
    typer.echo("")
    for path in paths[-2:]:
        typer.echo(str(path))


def _warn_if_no_key() -> None:
    # load_settings() has already read .env, so the environment is complete here.
    if not (os.environ.get("ANTHROPIC_API_KEY") or os.environ.get("ANTHROPIC_AUTH_TOKEN")):
        typer.echo(
            "warning: ANTHROPIC_API_KEY is not set; every panorama will get the harness fallback answer "
            "(the label's prior point) and an api_error event.",
            err=True,
        )


def _interrupt(signum: int, frame: Any) -> None:
    raise KeyboardInterrupt(f"signal {signum}")


def _terminate_like_ctrl_c() -> None:
    """A closed terminal (SIGHUP) or `kill` (SIGTERM) would otherwise end the process without
    running the finalise-and-export step that Ctrl-C gets."""
    for name in ("SIGTERM", "SIGHUP"):
        sig = getattr(signal, name, None)
        if sig is None:
            continue
        try:
            signal.signal(sig, _interrupt)
        except (ValueError, OSError):  # not the main thread, or not supported on this platform
            pass


def _run_batch(manager: RunManager, tasks: list[Any], concurrency: int | None) -> None:
    manager.add_tasks(tasks)
    _warn_if_no_key()
    typer.echo(f"run {manager.run_id}: {len(tasks)} panorama(s) -> {manager.run_dir}")
    _terminate_like_ctrl_c()
    try:
        asyncio.run(manager.start(concurrency))
    finally:
        # Even after Ctrl-C or a crash every panorama must leave with a valid answer and export.
        manager.finalize_all("run_interrupted")
        paths = manager.export_all()
        _print_summary(manager.summary, paths)
    if any(row.get("problems") for row in manager.summary):
        raise typer.Exit(code=1)


@app.command()
def run(
    pano: Path = typer.Argument(..., exists=True, dir_okay=False, help="Equirectangular panorama image."),
    label: Optional[str] = LabelOption,
    special: bool = typer.Option(False, "--special", help="This panorama is the Special One (x3, bigger budget)."),
    human: bool = typer.Option(False, "--human", help="Keep the human channels on (only useful with `serve`)."),
    hedge: bool = HedgeOption,
    no_web: bool = NoWebOption,
    live: bool = LiveOption,
    run_id: Optional[str] = RunIdOption,
) -> None:
    """Localise one panorama autonomously and write its export."""
    tasks = _load(pano, pano.name if special else None, label)
    manager = RunManager(_settings(no_human=not human, hedge=hedge, no_web=no_web), run_id=run_id, live=live)
    _run_batch(manager, tasks, 1)


@app.command()
def batch(
    directory: Path = typer.Argument(..., exists=True, file_okay=False, help="Directory of panoramas (+ manifest)."),
    concurrency: int = typer.Option(6, "--concurrency", min=1, help="Panoramas in parallel."),
    no_human: bool = typer.Option(
        True,
        "--no-human/--human",
        help="Fully autonomous. This command has no operator UI, so a question asked with --human "
        "costs x0.95 and can never be answered; use `serve` for assisted runs.",
    ),
    special: Optional[str] = typer.Option(None, "--special", help="File name or stem of the Special One."),
    label: Optional[str] = LabelOption,
    hedge: bool = HedgeOption,
    no_web: bool = NoWebOption,
    live: bool = LiveOption,
    run_id: Optional[str] = RunIdOption,
) -> None:
    """Run every panorama in a directory in parallel; writes one export each, summary.csv and answers.csv."""
    tasks = _load(directory, special, label)
    manager = RunManager(_settings(no_human=no_human, hedge=hedge, no_web=no_web), run_id=run_id, live=live)
    _run_batch(manager, tasks, concurrency)


@app.command()
def export(
    run_dir: Path = typer.Argument(..., exists=True, file_okay=False, help="runs/<run_id> directory."),
    embed_images: bool = typer.Option(False, "--embed-images", help="Inline base64 images in each export."),
) -> None:
    """Rebuild the per-panorama exports, summary.csv and answers.csv from a run's event logs."""
    settings = load_settings()
    paths, rows = export_run(run_dir, team=settings.team, embed_images=embed_images or settings.embed_images)
    if not rows:
        typer.echo(f"error: no event logs (*.events.jsonl) in {run_dir}", err=True)
        raise typer.Exit(code=2)
    _print_summary(rows, paths)
    if any(row.get("problems") for row in rows):
        raise typer.Exit(code=1)


@app.command("eval", context_settings={"allow_extra_args": True, "ignore_unknown_options": True}, add_help_option=False)
def eval_(ctx: typer.Context) -> None:
    """Evaluation harness (run | rescore | compare); arguments are passed to eval.run_eval."""
    from eval.run_eval import app as eval_app

    eval_app(args=ctx.args, prog_name="cli.py eval")


# An open operator tab holds /api/stream forever; without a limit uvicorn waits on it and Ctrl-C hangs.
GRACEFUL_SHUTDOWN_S = 3


def _uvicorn_config(asgi_app: Any, host: str, port: int) -> Any:
    import uvicorn

    return uvicorn.Config(
        asgi_app, host=host, port=port, log_level="info", timeout_graceful_shutdown=GRACEFUL_SHUTDOWN_S
    )


async def _serve(manager: RunManager, host: str, port: int, concurrency: int | None) -> None:
    import uvicorn

    from server.app import create_app

    async def run_then_export() -> None:
        await manager.start(concurrency)
        await asyncio.to_thread(manager.export_all)

    server = uvicorn.Server(_uvicorn_config(create_app(manager), host, port))
    job = asyncio.create_task(run_then_export()) if manager.sessions else None
    try:
        await server.serve()
    finally:
        if job is not None:
            job.cancel()
            await asyncio.gather(job, return_exceptions=True)


def _serve_blocking(manager: RunManager, host: str, port: int, concurrency: int | None) -> None:
    """Run the server until it stops, then finalise and export whatever happened.

    The last step is outside the event loop on purpose: after Ctrl-C uvicorn re-raises the signal,
    asyncio cancels the main task, and anything awaited in `_serve`'s own cleanup is cancelled with
    it, which used to skip both the finalise and the export."""
    _terminate_like_ctrl_c()
    try:
        asyncio.run(_serve(manager, host, port, concurrency))
    finally:
        manager.finalize_all("server_shutdown")
        paths = manager.export_all()
        for path in paths[-2:]:
            typer.echo(str(path))


@app.command()
def serve(
    directory: Optional[Path] = typer.Argument(None, exists=True, help="Panorama directory (or one image) to run."),
    host: str = typer.Option("127.0.0.1", "--host"),
    port: int = typer.Option(8000, "--port"),
    concurrency: Optional[int] = typer.Option(None, "--concurrency", min=1, help="Panoramas in parallel."),
    no_human: bool = typer.Option(False, "--no-human", help="Disable the three operator controls."),
    special: Optional[str] = typer.Option(None, "--special", help="File name or stem of the Special One."),
    label: Optional[str] = LabelOption,
    hedge: bool = HedgeOption,
    no_web: bool = NoWebOption,
    live: bool = LiveOption,
    run_id: Optional[str] = RunIdOption,
) -> None:
    """Start the operator UI and run the panoramas behind it; exports are written when the runs end."""
    manager = RunManager(_settings(no_human=no_human, hedge=hedge, no_web=no_web), run_id=run_id, live=live)
    if directory is not None:
        manager.add_tasks(_load(directory, special, label))
        _warn_if_no_key()
    typer.echo(f"run {manager.run_id}: {len(manager.sessions)} panorama(s) -> {manager.run_dir}")
    typer.echo(f"operator UI: http://{host}:{port}")
    _serve_blocking(manager, host, port, concurrency)


if __name__ == "__main__":
    app()
