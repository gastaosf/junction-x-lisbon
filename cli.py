"""Command line entry point: serve [<dir>] | run <pano> | batch <dir> | export <run_dir> | eval ..."""

from __future__ import annotations

import asyncio
import os
import signal
from pathlib import Path
from typing import Any, Optional

import typer

from astrolabio.config import Settings, load_settings
from astrolabio.runner import RunManager, describe_tasks, export_run, load_tasks
from astrolabio.schema import Label

# Read here, before any command can load .env (nothing imported above does): only the
# environment this process was started with may select the scripted demo model. A line left in
# .env must not turn a scoring run into a demo.
_FAKE_MODEL_AT_START = os.environ.get("ASTROLABIO_FAKE_MODEL")

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
    # OPENAI_ADMIN_KEY alone would satisfy the SDK's constructor, but it is not a model-calling key.
    if not os.environ.get("OPENAI_API_KEY"):
        typer.echo(
            "warning: OPENAI_API_KEY is not set; every panorama will get the harness fallback answer "
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


def _truthy(raw: Optional[str]) -> bool:
    return (raw or "").strip().lower() in {"1", "true", "yes", "on"}


async def _serve_console(
    workspace: Any, host: str, port: int, launch: dict[str, Any] | None = None, *, open_url: str | None = None
) -> None:
    """Serve the console until the server stops. `launch` (the arguments of
    `Workspace.launch_path`) starts that run once the port is bound, so a port that is taken
    never leaves a paid run going with no page to operate it from."""
    import uvicorn

    from server.console import create_console_app
    from server.middleware import is_loopback

    # a LAN address named on the command line is the one the console answers under
    lan_host = None if host == "0.0.0.0" or is_loopback(host) else host
    console = create_console_app(workspace, port=port, lan_host=lan_host)
    server = uvicorn.Server(_uvicorn_config(console, host, port))
    failed: list[Exception] = []

    async def once_started() -> None:
        while not server.started:
            await asyncio.sleep(0.05)
        if launch is not None:
            try:
                started = await workspace.launch_path(**launch)
            except Exception as exc:  # a server left running without the run it was started for helps nobody
                failed.append(exc)
                server.should_exit = True
                return
            typer.echo(f"run {started['run_id']} -> {workspace.runs_dir / started['run_id']}")
        if open_url is not None:
            import webbrowser

            await asyncio.to_thread(webbrowser.open, open_url)

    follow_up = asyncio.create_task(once_started())
    try:
        await server.serve()
    finally:
        follow_up.cancel()
        # Finalise while the loop still runs, so every panorama gets its run_end. After Ctrl-C this
        # task is already cancelled and only the synchronous first part happens; what is left is
        # done by shutdown_sync once the loop has stopped.
        await workspace.shutdown()
    if failed:
        raise failed[0]


def _serve_console_blocking(
    workspace: Any, host: str, port: int, launch: dict[str, Any] | None, *, open_url: str | None = None
) -> None:
    """Run the console until it stops, then finalise and export every run that was still going.
    As in `_serve_blocking`, the last step is outside the event loop: what is awaited in the
    loop's own cleanup is cancelled together with it."""
    _terminate_like_ctrl_c()
    try:
        asyncio.run(_serve_console(workspace, host, port, launch, open_url=open_url))
    finally:
        for path in workspace.shutdown_sync()[-2:]:
            typer.echo(str(path))


def _serve_legacy(
    directory: Optional[Path],
    host: str,
    port: int,
    concurrency: Optional[int],
    no_human: bool,
    special: Optional[str],
    label: Optional[str],
    hedge: bool,
    no_web: bool,
    live: bool,
    run_id: Optional[str],
) -> None:
    """The single-run server as it was before the console: one run fixed at start-up."""
    manager = RunManager(_settings(no_human=no_human, hedge=hedge, no_web=no_web), run_id=run_id, live=live)
    if directory is not None:
        manager.add_tasks(_load(directory, special, label))
        _warn_if_no_key()
    typer.echo(f"run {manager.run_id}: {len(manager.sessions)} panorama(s) -> {manager.run_dir}")
    typer.echo(f"operator UI: http://{host}:{port}")
    _serve_blocking(manager, host, port, concurrency)


@app.command()
def serve(
    directory: Optional[Path] = typer.Argument(None, exists=True, help="Panorama directory (or one image) to run."),
    host: Optional[str] = typer.Option(
        None, "--host", help="Address to bind (default 127.0.0.1; a LAN address needs LAN access on in Settings)."
    ),
    port: int = typer.Option(8000, "--port"),
    concurrency: Optional[int] = typer.Option(None, "--concurrency", min=1, help="Panoramas in parallel."),
    no_human: bool = typer.Option(False, "--no-human", help="Disable the three operator controls."),
    special: Optional[str] = typer.Option(None, "--special", help="File name or stem of the Special One."),
    label: Optional[str] = LabelOption,
    hedge: bool = HedgeOption,
    no_web: bool = NoWebOption,
    live: bool = LiveOption,
    run_id: Optional[str] = RunIdOption,
    no_open: bool = typer.Option(False, "--no-open", help="Do not open the console in the browser."),
    legacy: bool = typer.Option(False, "--legacy", help="The old single-run server and page, as before the console."),
) -> None:
    """Start the web console (runs, launch, operator controls, submission, evaluation, settings).

    With a directory, that run is launched as well, as the command always did. Runs still going
    when the server stops are finalised and exported."""
    if legacy:
        _serve_legacy(
            directory, host or "127.0.0.1", port, concurrency, no_human, special, label, hedge, no_web, live, run_id
        )
        return

    from server.middleware import is_loopback, lan_address
    from server.workspace import Workspace

    default_label = _parse_label(label)
    if directory is not None:
        _load(directory, special, label)  # the parsed table, and exit 2 here rather than behind a started server
    # Two overrides for trying the console out without touching real data: where the evaluation
    # set lives, and which .env file the Settings screen writes keys to.
    workspace = Workspace(
        fake_model=_truthy(_FAKE_MODEL_AT_START),
        eval_data_dir=os.environ.get("ASTROLABIO_EVAL_DATA_DIR") or None,
        env_path=os.environ.get("ASTROLABIO_ENV_FILE") or None,
    )
    lan = workspace.store.lan()
    if host is None:
        host = "0.0.0.0" if lan["enabled"] else "127.0.0.1"
    if not is_loopback(host) and not lan["enabled"]:
        typer.echo(
            f"error: --host {host} would open the console to the network. It has no login: switch on LAN "
            "access in Settings (it adds a shared token) and restart, or bind a loopback address.",
            err=True,
        )
        raise typer.Exit(code=2)

    url = f"http://127.0.0.1:{port}"
    open_url = None if no_open else url + "/"
    typer.echo(f"astrolabio console: {url}")
    if lan["enabled"]:
        address = lan_address() if host == "0.0.0.0" else host
        if is_loopback(host):
            typer.echo("LAN access is on in Settings, but --host binds this machine only.")
        elif address is None:
            typer.echo("warning: LAN access is on, but this machine has no network address to share.", err=True)
        else:
            # The one place the token is shown: whoever can read this terminal may join.
            typer.echo(f"join from another laptop: http://{address}:{port}/?token={lan['token']}")
        open_url = None if no_open else f"{url}/?token={lan['token']}"
    if workspace.fake_model:
        typer.echo("ASTROLABIO_FAKE_MODEL is set: runs use the scripted demo model (no API calls, demo answers).")
    elif _truthy(os.environ.get("ASTROLABIO_FAKE_MODEL")):
        typer.echo("warning: ASTROLABIO_FAKE_MODEL in .env was ignored; set it on the command line for a demo.", err=True)
    elif not os.environ.get("OPENAI_API_KEY"):
        typer.echo(
            "warning: OPENAI_API_KEY is not set; set it under Settings in the console. Until then every "
            "panorama gets the harness fallback answer (the label's prior point).",
            err=True,
        )

    launch = None
    if directory is not None:
        launch = {
            "path": directory,
            "special": special,
            "label": default_label,
            # None leaves the saved default in place; a flag can only switch a feature one way.
            "settings_overrides": {
                "no_human": True if no_human else None,
                "hedge": True if hedge else None,
                "allow_web": False if no_web else None,
            },
            "live": live,
            "run_id": run_id,
            "concurrency": concurrency,
        }

    from server.sets import ConsoleError

    try:
        _serve_console_blocking(workspace, host, port, launch, open_url=open_url)
    except ConsoleError as exc:
        typer.echo(f"error: {exc.message}", err=True)
        raise typer.Exit(code=2) from None


if __name__ == "__main__":
    app()
