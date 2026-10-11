"""Settings, keys, health and cache (console contract 4.7).

Nothing here reaches a run that has started: saved defaults apply to the next launch, a key to the
next client built, directories and the LAN switch to the next server start. Every string of every
answer, errors included, passes `security.redact`; a key value comes in and never goes out.
"""

from __future__ import annotations

import asyncio
import weakref
from collections.abc import Mapping
from pathlib import Path
from typing import Any, get_args

from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import Response

from astrolabio.config import Effort, Settings
from astrolabio.tools.schemas import ALL_TOOL_NAMES, PROTECTED_TOOLS

from .. import health
from ..middleware import is_loopback, lan_address
from ..security import KEY_NAMES, redact
from ..store import (
    BUDGET_FIELDS,
    LAUNCH_FIELDS,
    MAX_CONCURRENCY,
    MAX_MCQ_LIMIT,
    MAX_OUTPUT_TOKENS,
    SettingsError,
    validate_launch_settings,
)
from ..workspace import Workspace, public_settings
from . import flag, idempotent, json_body, lan_enabled, refuse, reply, workspace

router = APIRouter()

SECTIONS = ("defaults", "organiser_answers", "paths", "lan")
# UI-SPEC 5.3 step 4, in its order.
GROUPS = ("Run", "Autonomy", "Model", "Budgets", "Tools", "Answer", "Orchestration", "Export")
_BUDGET_NAMES = {"standard": "standard", "special": "Special One", "live": "live"}

_started: "weakref.WeakKeyDictionary[Workspace, dict[str, Any]]" = weakref.WeakKeyDictionary()


def _clean(ws: Workspace, value: Any) -> Any:
    """`value` with every string in it redacted: the keys, and the LAN token, which only the
    join link may carry."""
    token = ws.store.lan()["token"]
    extra = (token,) if token else ()

    def walk(item: Any) -> Any:
        if isinstance(item, str):
            return redact(item, extra=extra)
        if isinstance(item, Mapping):
            return {key: walk(inner) for key, inner in item.items()}
        if isinstance(item, (list, tuple)):
            return [walk(inner) for inner in item]
        return item

    return walk(value)


def _refuse(request: Request, status: int, message: str, **more: Any) -> HTTPException:
    """`refuse`, with the problems and anything else in the detail redacted like the message."""
    return refuse(status, **_clean(workspace(request), {"message": message, **more}))


def _local(request: Request) -> bool:
    """The browser is on the machine the server runs on."""
    return request.client is not None and is_loopback(request.client.host)


# ---------------------------------------------------------------------------------------------
# what a restart would change


def _started_with(request: Request) -> dict[str, Any]:
    """The LAN switch and the saved directories as this server found them. They change only
    through `PUT /api/settings`, which looks here before it writes, so the first look is the
    state the server started with."""
    ws = workspace(request)
    state = _started.get(ws)
    if state is None:
        state = _started[ws] = {"lan": lan_enabled(request), **ws.store.paths()}
    return state


def _lan_on(request: Request) -> bool:
    """Serving the LAN now, or set to from the next start: either way keys stay out of reach."""
    return _started_with(request)["lan"] or workspace(request).store.lan()["enabled"]


def _absolute(path: str | Path) -> Path:
    return Path(path).expanduser().resolve()


def _restart_required(request: Request) -> list[str]:
    ws = workspace(request)
    started = _started_with(request)
    saved = ws.store.paths()
    out = []
    for key, current in (("runs_dir", ws.runs_dir), ("cache_dir", ws.cache_dir)):
        if saved[key] is None:
            # reset since the start: the next one reads the environment again
            changed = started[key] is not None
        else:
            changed = _absolute(saved[key]) != _absolute(current)
        if changed:
            out.append(key)
    if ws.store.lan()["enabled"] != started["lan"]:
        out.append("lan")
    return out


# ---------------------------------------------------------------------------------------------
# the form


def _field(key: str, group: str, label: str, kind: str, help: str, **more: Any) -> dict[str, Any]:
    return {"key": key, "group": group, "label": label, "type": kind, "help": help, **more}


def _fields(ws: Workspace) -> list[dict[str, Any]]:
    """One entry per value a launch may set; `key` is a path into `defaults` (`standard.max_turns`).
    Bounds and choices are hints for the form: the server validates whatever is sent."""
    efforts = list(get_args(Effort))
    choices = {
        name: list(get_args(Settings.model_fields[name].annotation)) for name in ("image_detail", "penalty_scope")
    }
    switchable = [name for name in ALL_TOOL_NAMES if name not in PROTECTED_TOOLS]
    fields = [
        _field("team", "Run", "Team name", "text", "Written into every export and into summary.csv.", max_length=40),
        _field(
            "no_human",
            "Autonomy",
            "Autonomous (human channels off)",
            "bool",
            "On: no question, cue or geocode can be sent and the agent is told it works alone. "
            "Every preset except Custom sets this itself.",
        ),
        _field(
            "mcq_allowed",
            "Autonomy",
            "Questions allowed at start",
            "bool",
            "Off: the agent's questions are refused at no cost until the operator allows them on a panorama.",
        ),
        _field(
            "max_mcq",
            "Autonomy",
            "Max MCQs per panorama",
            "int",
            "Each question costs x0.95 when it is asked, answered or not (R7).",
            min=0,
            max=MAX_MCQ_LIMIT,
        ),
        _field(
            "model",
            "Model",
            "Model",
            "choice",
            "Prices follow the model. A run keeps the model it was launched with.",
            choices=list(ws.models()),
        ),
    ]
    fields += [
        _field(
            f"{budget}.effort",
            "Model",
            f"Effort, {name}",
            "choice",
            "Reasoning effort requested on every turn of such a panorama.",
            choices=efforts,
        )
        for budget, name in _BUDGET_NAMES.items()
    ]
    fields += [
        _field(
            "max_tokens",
            "Model",
            "max_output_tokens",
            "int",
            "Reasoning counts toward it: set too low, a turn ends before any tool call.",
            min=1,
            max=MAX_OUTPUT_TOKENS,
        ),
        _field(
            "image_detail",
            "Model",
            "Image detail",
            "choice",
            "Sent with every image. 'original' keeps each view at the size the harness rendered it.",
            choices=choices["image_detail"],
        ),
    ]
    for budget, name in _BUDGET_NAMES.items():
        fields += [
            _field(
                f"{budget}.soft_deadline_s",
                "Budgets",
                f"Soft deadline, {name}",
                "number",
                "After this the agent is told to commit. Not later than the hard deadline.",
                min=1,
                unit="s",
            ),
            _field(
                f"{budget}.hard_deadline_s",
                "Budgets",
                f"Hard deadline, {name}",
                "number",
                "At this point the best list so far is used, and the cue and question window closes.",
                min=1,
                unit="s",
            ),
            _field(
                f"{budget}.max_turns",
                "Budgets",
                f"Max turns, {name}",
                "int",
                "Model requests per panorama before the best list so far is used.",
                min=1,
            ),
            _field(
                f"{budget}.max_spend_usd",
                "Budgets",
                f"Max spend, {name}",
                "number",
                "Spend cap per panorama; the cost ceiling of a run is the sum of these.",
                min=0.01,
                unit="USD",
            ),
        ]
    fields += [
        _field(
            "allow_web",
            "Tools",
            "Web tools on (Q1)",
            "bool",
            "Off switches every external tool off: web search, geocoding, street-level and satellite imagery.",
        ),
        _field(
            "disabled_tools",
            "Tools",
            "Tools switched off",
            "tools",
            f"For ablations. {' and '.join(sorted(PROTECTED_TOOLS))} cannot be switched off.",
            choices=switchable,
        ),
        _field(
            "hedge",
            "Answer",
            "Hedge",
            "bool",
            "On: when the top candidate is uncertain, some of the ten entries go to the best candidate "
            "outside its cluster. Off: the best point is repeated.",
        ),
        _field(
            "allow_duplicates",
            "Answer",
            "Allow duplicates (Q3)",
            "bool",
            "Off gives the ten best distinct points instead of repeats.",
        ),
        _field(
            "penalty_scope",
            "Answer",
            "Penalty scope (Q2)",
            "choice",
            "whole_list: a penalty multiplies all ten entries. subsequent: only entries changed after it.",
            choices=choices["penalty_scope"],
        ),
        _field(
            "concurrency",
            "Orchestration",
            "Concurrency",
            "int",
            "Panoramas worked on at the same time. They share the API rate limits.",
            min=1,
            max=MAX_CONCURRENCY,
        ),
        _field(
            "global_watchdog_s",
            "Orchestration",
            "Global watchdog",
            "number",
            "This long after a run starts, every panorama still going is finalised (Q10).",
            min=1,
            unit="s",
        ),
        _field(
            "embed_images",
            "Export",
            "Embed images (Q4)",
            "bool",
            "On: every image the model saw is written into the export as base64. Large files.",
        ),
    ]
    return fields


def _payload(request: Request) -> dict[str, Any]:
    ws = workspace(request)
    defaults = public_settings(ws.build_settings())
    lan = ws.store.lan()
    # the address the middleware answers to, once LAN access is in force; else the one it will pick
    address = getattr(request.app.state, "lan_host", None) or lan_address()
    body = _clean(
        ws,
        {
            "defaults": defaults,
            # the ones saved here; the rest follow the environment and can be reset to it with null
            "overridden": sorted(ws.store.defaults()),
            "fields": _fields(ws),
            "keys": health.key_status(),
            "keys_editable": not _lan_on(request),
            "paths": {
                "runs_dir": str(_absolute(ws.runs_dir)),
                "cache_dir": str(_absolute(ws.cache_dir)),
                "data_dir": str(_absolute(ws.data_dir)),
                "allowed_roots": [str(root) for root in ws.store.allowed_roots()],
                # what the next start will use; null: the environment (RUNS_DIR, CACHE_DIR)
                "saved": ws.store.paths(),
                "env_file": str(ws.env_path),
            },
            "organiser_answers": ws.store.organiser_answers(defaults),
            "lan": {
                "enabled": lan["enabled"],
                "token_set": lan["token"] is not None,
                "address": address,
                "join_url": None,
            },
            "restart_required": _restart_required(request),
        },
    )
    # The one response the token leaves in, and only towards the machine the server runs on.
    if lan["enabled"] and address and _local(request):
        port = getattr(request.app.state, "port", None) or request.url.port
        body["lan"]["join_url"] = f"http://{address}{f':{port}' if port else ''}/?token={lan['token']}"
    return body


# ---------------------------------------------------------------------------------------------
# saving


def _checked_defaults(ws: Workspace, values: Any) -> dict[str, Any]:
    """Defaults ready for the store, or SettingsError, with nothing written. A form may send one
    field of a budget; the store keeps budgets whole, so the rest is filled in from the values
    in force."""
    if not isinstance(values, Mapping):
        raise SettingsError(["defaults must be an object"])
    unknown = sorted(str(key) for key in values if key not in LAUNCH_FIELDS)
    if unknown:
        raise SettingsError(
            [f"{key} is not a setting a run can be launched with" for key in unknown], code="unknown_setting"
        )
    out = dict(values)
    current = public_settings(ws.build_settings())
    for key in BUDGET_FIELDS:
        if isinstance(out.get(key), Mapping):
            out[key] = {**current[key], **out[key]}
    validate_launch_settings({k: v for k, v in out.items() if v is not None}, models=ws.models())
    return out


def _changed_answers(ws: Workspace, items: Any) -> Any:
    """The form sends the table as it shows it. Only an answer that differs from the value in
    force is a change: saving the others would pin today's defaults as if the operator chose them."""
    if not isinstance(items, list):
        return items
    in_force = {row["id"]: row["value"] for row in ws.store.organiser_answers(public_settings(ws.build_settings()))}
    changed = []
    for item in items:
        if isinstance(item, Mapping) and "value" in item and item["value"] == in_force.get(item.get("id"), item):
            item = {key: value for key, value in item.items() if key != "value"}
        changed.append(item)
    return changed


def _checked(ws: Workspace, body: Mapping[str, Any]) -> dict[str, Any]:
    """The body with everything checked that can be checked without writing."""
    plan = dict(body)
    if "defaults" in plan:
        plan["defaults"] = _checked_defaults(ws, plan["defaults"])
    if "organiser_answers" in plan:
        plan["organiser_answers"] = _changed_answers(ws, plan["organiser_answers"])
        ws.store.set_organiser_answers(plan["organiser_answers"], models=ws.models(), dry_run=True)
    if "paths" in plan:
        ws.store.set_paths(plan["paths"], dry_run=True)
    if "lan" in plan:
        lan = plan["lan"]
        if not isinstance(lan, Mapping) or set(lan) != {"enabled"} or not isinstance(lan["enabled"], bool):
            raise SettingsError(["lan must be {\"enabled\": true or false}"])
    return plan


def _apply(ws: Workspace, plan: Mapping[str, Any], saved: list[str]) -> None:
    """Blocking. The two sections only the store can judge go first, so that a refusal there
    leaves as little as possible already written; `saved` names what was."""
    store, models = ws.store, ws.models()
    steps = {
        "organiser_answers": lambda items: store.set_organiser_answers(items, models=models),
        "paths": store.set_paths,
        "defaults": lambda values: store.set_defaults(values, models=models),
        "lan": lambda lan: store.set_lan(lan["enabled"]),
    }
    for section, save in steps.items():
        if section in plan:
            save(plan[section])
            saved.append(section)


def _settings_refusal(request: Request, exc: SettingsError, saved: list[str] | None = None) -> HTTPException:
    message = "; ".join(exc.problems) + "."
    if saved:
        message += f" Already saved by this request: {', '.join(saved)}."
    return _refuse(request, 422, message, code=exc.code, problems=list(exc.problems), saved=saved or [])


@router.get("/api/settings")
async def get_settings(request: Request) -> Response:
    return reply(_payload(request))


@router.put("/api/settings")
async def put_settings(request: Request) -> Response:
    ws = workspace(request)
    body = await json_body(request)
    unknown = sorted(str(key) for key in body if key not in SECTIONS)
    if unknown:
        raise _refuse(
            request,
            422,
            f"Settings are saved as any of {', '.join(SECTIONS)}; this request also had {', '.join(unknown)}.",
            code="unknown_setting",
            problems=[f"{key} is not a section of the settings" for key in unknown],
        )
    if _lan_on(request):
        # A second laptop must not widen what the server's disk shows, or open the door further.
        if "paths" in body:
            raise _refuse(
                request,
                403,
                "Directories cannot be changed while LAN access is on. Switch LAN access off on the "
                "server's own machine, restart, then change them.",
                code="lan_access_on",
            )
        # Switching it off again must stay possible, but only from the machine itself.
        if "lan" in body and not _local(request):
            raise _refuse(
                request,
                403,
                "LAN access can only be changed in a browser on the machine the server runs on.",
                code="lan_access_on",
            )
    try:
        plan = _checked(ws, body)
    except SettingsError as exc:
        raise _settings_refusal(request, exc) from exc
    saved: list[str] = []
    try:
        await asyncio.to_thread(_apply, ws, plan, saved)
    except SettingsError as exc:
        raise _settings_refusal(request, exc, saved) from exc
    # Every tab hears of it: the chips carry the LAN switch, and a tab that shows Settings reads
    # the saved values again when a `health` message arrives.
    ws.publish_health()
    return reply(_payload(request))


# ---------------------------------------------------------------------------------------------
# keys


def _key_route(request: Request, name: str) -> Workspace:
    """The workspace, once the name is one of the three keys and keys may be touched at all."""
    # An allow-list: anything else would be a write to an arbitrary environment variable.
    if name not in KEY_NAMES:
        raise _refuse(request, 404, f"No such key. The console manages {', '.join(KEY_NAMES)}.", code="unknown_key")
    if _lan_on(request):
        raise _refuse(
            request,
            403,
            "Keys cannot be changed or tested while LAN access is on. Switch LAN access off and "
            "restart the server, or edit .env on the server's machine.",
            code="lan_access_on",
        )
    return workspace(request)


@router.put("/api/settings/keys/{name}")
async def put_key(name: str, request: Request) -> Response:
    ws = _key_route(request, name)
    body = await json_body(request)
    if set(body) != {"value"}:
        raise _refuse(request, 422, "Send {\"value\": \"<the key>\"} and nothing else.", code="invalid_body")
    try:
        result = await health.set_key(ws, name, body["value"])
    except health.KeyValueError as exc:
        raise _refuse(request, 422, str(exc), code="invalid_key") from exc
    except OSError as exc:
        raise _refuse(
            request,
            500,
            f"The key could not be written to {ws.env_path} ({type(exc).__name__}); nothing was "
            "changed. Check that the file and its directory are writable.",
            code="env_not_writable",
        ) from exc
    return reply(_clean(ws, result))


@router.post("/api/settings/keys/{name}/test")
async def post_key_test(name: str, request: Request) -> Response:
    ws = _key_route(request, name)

    async def work() -> dict[str, Any]:
        return _clean(ws, await health.run_key_test(ws, name))

    return await idempotent(request, work)


# ---------------------------------------------------------------------------------------------
# health and cache


@router.get("/api/health")
async def get_health(request: Request) -> Response:
    ws = workspace(request)
    refresh = flag(request.query_params.get("refresh"), "refresh") or False
    return reply(_clean(ws, await health.report(ws, refresh=refresh)))


@router.post("/api/cache/clear")
async def clear_cache(request: Request) -> Response:
    ws = workspace(request)
    body = await json_body(request)
    if body.get("confirm") is not True:
        raise _refuse(
            request,
            422,
            "Send {\"confirm\": true}. Clearing the HTTP cache means every cached lookup is fetched again.",
            code="confirm_required",
            action="confirm",
        )

    async def work() -> dict[str, Any]:
        try:
            removed = await asyncio.to_thread(health.clear_http_cache, ws)
        except PermissionError as exc:
            raise _refuse(request, 403, f"The HTTP cache was not cleared: {exc}.", code="forbidden_path") from exc
        return {"ok": True, "removed_bytes": removed}

    return await idempotent(request, work)
