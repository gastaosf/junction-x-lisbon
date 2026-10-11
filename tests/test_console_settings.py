"""Settings, keys, health and cache routes of the console. Offline: the .env is a tmp_path file,
key tests go to an injected tester, reachability probes to an httpx mock transport."""

from __future__ import annotations

import asyncio
import json
import os
import stat
from pathlib import Path
from typing import Any

import httpx
import pytest
from fastapi import FastAPI

from astrolabio.config import Settings
from server import health
from server.routes import settings as settings_routes
from server.routes.settings import GROUPS, router
from server.security import KEY_NAMES, REDACTED
from server.store import LAUNCH_FIELDS, ConsoleStore
from server.workspace import Workspace

SECRETS = {
    "OPENAI_API_KEY": "sk-test-openai-0123456789",
    "GOOGLE_MAPS_API_KEY": "AIzaTestGoogleKey0123456789",
    "MAPILLARY_TOKEN": "MLY|1234567890|0123456789abcdef",
}
NEW_KEY = "sk-proj-NEW_key-abcdefghijkl9876"
LAN_ADDRESS = "192.168.1.50"
LAPTOP = "192.168.1.77"


@pytest.fixture(autouse=True)
def offline(monkeypatch: pytest.MonkeyPatch) -> None:
    """No key of the developer's environment, and no way out: a probe that is not given a mock
    transport fails the test instead of opening a connection."""
    for name in (*KEY_NAMES, "OPENAI_BASE_URL", "OPENAI_ORG_ID", "OPENAI_PROJECT_ID"):
        # set first: monkeypatch only restores what it recorded, and the key route writes
        # os.environ itself. Without this a key saved by one test would outlive it.
        monkeypatch.setenv(name, "recorded")
        monkeypatch.delenv(name)

    def no_network(settings: Settings) -> httpx.AsyncClient:
        raise AssertionError("a test reached the real probe client")

    monkeypatch.setattr(health, "make_probe_client", no_network)
    monkeypatch.setattr(settings_routes, "lan_address", lambda: LAN_ADDRESS)


def set_keys(monkeypatch: pytest.MonkeyPatch, *names: str) -> None:
    for name in names or KEY_NAMES:
        monkeypatch.setenv(name, SECRETS[name])


def workspace(tmp_path: Path, key_tester: Any = None, **overrides: Any) -> Workspace:
    base = Settings(**{"runs_dir": tmp_path / "runs", "cache_dir": tmp_path / "cache", **overrides})
    return Workspace(
        base,
        data_dir=tmp_path / "data",
        eval_data_dir=tmp_path / "eval",
        env_path=tmp_path / ".env",
        key_tester=key_tester,
        fake_model=False,
    )


def api(ws: Workspace, peer: str = "127.0.0.1", **state: Any) -> httpx.AsyncClient:
    """A browser at `peer` on a bare app; `state` is what the console app would put on app.state."""
    app = FastAPI()
    app.state.workspace = ws
    for name, value in state.items():
        setattr(app.state, name, value)
    app.include_router(router)
    transport = httpx.ASGITransport(app=app, client=(peer, 50000))
    return httpx.AsyncClient(transport=transport, base_url="http://127.0.0.1:8000")


def keyless(response: httpx.Response) -> httpx.Response:
    """The response, once it is certain that no key value is anywhere in it."""
    haystack = response.text + json.dumps(dict(response.headers))
    for value in (*SECRETS.values(), NEW_KEY):
        assert value not in haystack
    return response


def detail(response: httpx.Response) -> dict[str, Any]:
    return keyless(response).json()["detail"]


def dig(values: dict[str, Any], dotted: str) -> Any:
    for part in dotted.split("."):
        values = values[part]
    return values


# ---------------------------------------------------------------------------------------------
# GET /api/settings


async def test_settings_describe_every_launch_field_and_never_a_key(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    set_keys(monkeypatch, "OPENAI_API_KEY", "MAPILLARY_TOKEN")
    ws = workspace(tmp_path, team="albatross")
    async with api(ws) as http:
        body = keyless(await http.get("/api/settings")).json()

    assert set(body["defaults"]) == set(LAUNCH_FIELDS)
    assert body["defaults"]["team"] == "albatross"
    assert body["overridden"] == []

    fields = body["fields"]
    assert {field["key"].split(".")[0] for field in fields} == set(LAUNCH_FIELDS)
    assert len({field["key"] for field in fields}) == len(fields)
    assert list(dict.fromkeys(field["group"] for field in fields)) == list(GROUPS)
    for field in fields:
        assert {"key", "group", "label", "type", "help"} <= set(field)
        value = dig(body["defaults"], field["key"])  # every key is a path into the defaults
        if field["type"] == "choice":
            assert value in field["choices"]
    by_key = {field["key"]: field for field in fields}
    assert by_key["model"]["choices"] == list(ws.models())
    assert (by_key["max_mcq"]["min"], by_key["max_mcq"]["max"]) == (0, 3)
    assert (by_key["concurrency"]["min"], by_key["concurrency"]["max"]) == (1, 12)
    assert not {"update_candidates", "submit_locations"} & set(by_key["disabled_tools"]["choices"])
    assert by_key["special.effort"]["group"] == "Model"
    assert by_key["live.hard_deadline_s"]["group"] == "Budgets"
    assert REDACTED not in json.dumps(fields)  # redaction leaves the form's own words alone

    assert body["keys"] == {
        "OPENAI_API_KEY": {"set": True, "last4": "6789"},
        "GOOGLE_MAPS_API_KEY": {"set": False},
        "MAPILLARY_TOKEN": {"set": True},
    }
    assert body["keys_editable"] is True
    paths = body["paths"]
    assert paths["runs_dir"] == str((tmp_path / "runs").resolve())
    assert paths["cache_dir"] == str((tmp_path / "cache").resolve())
    assert paths["data_dir"] == str((tmp_path / "data").resolve())
    assert paths["allowed_roots"] == [str(root) for root in ws.store.allowed_roots()]
    assert paths["saved"] == {"runs_dir": None, "cache_dir": None}
    assert paths["env_file"] == str(tmp_path / ".env")

    answers = body["organiser_answers"]
    assert [row["id"] for row in answers] == [f"Q{n}" for n in range(1, 13)]
    assert {"question", "default", "control", "setting", "value", "note", "noted_at"} <= set(answers[0])
    assert answers[0]["setting"] == "allow_web" and answers[0]["value"] is True
    assert body["lan"] == {"enabled": False, "token_set": False, "address": LAN_ADDRESS, "join_url": None}
    assert body["restart_required"] == []
    assert not (tmp_path / ".env").exists()  # reading settings writes nothing


# ---------------------------------------------------------------------------------------------
# PUT /api/settings


async def test_defaults_are_saved_for_new_runs(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    async with api(ws) as http:
        put = await http.put(
            "/api/settings",
            json={"defaults": {"hedge": True, "team": "albatross", "concurrency": 3, "standard": {"max_turns": 7}}},
        )
        assert put.status_code == 200
        body = put.json()
        assert body["defaults"]["hedge"] is True and body["defaults"]["concurrency"] == 3
        # one field of a budget was sent: the others keep the values in force
        assert body["defaults"]["standard"] == {**Settings().standard.model_dump(), "max_turns": 7}
        assert body["overridden"] == ["concurrency", "hedge", "standard", "team"]
        assert body == (await http.get("/api/settings")).json()

        settings = ws.build_settings()
        assert (settings.hedge, settings.team, settings.concurrency, settings.standard.max_turns) == (
            True,
            "albatross",
            3,
            7,
        )
        saved = json.loads((tmp_path / "data" / "console.json").read_text())
        assert saved["defaults"]["team"] == "albatross"

        # null forgets one saved default; the rest stay
        reset = (await http.put("/api/settings", json={"defaults": {"hedge": None}})).json()
        assert reset["defaults"]["hedge"] is False and reset["overridden"] == ["concurrency", "standard", "team"]


@pytest.mark.parametrize(
    "key, value",
    [
        ("cue_max_chars", 5000),
        ("mcq_timeout_s", 600),
        ("runs_dir", "/tmp/elsewhere"),
        ("nominatim_url", "https://example.org"),
        ("google_maps_api_key", "x" * 20),
        ("OPENAI_API_KEY", "x" * 20),
        ("no_such_setting", None),
    ],
)
async def test_an_unknown_default_is_refused_and_nothing_is_saved(tmp_path: Path, key: str, value: Any) -> None:
    ws = workspace(tmp_path)
    async with api(ws) as http:
        put = await http.put("/api/settings", json={"defaults": {"hedge": True, key: value}})
    assert put.status_code == 422
    assert detail(put)["code"] == "unknown_setting"
    assert key in detail(put)["problems"][0]
    assert ws.store.defaults() == {} and not (tmp_path / "data" / "console.json").exists()


@pytest.mark.parametrize(
    "defaults",
    [
        {"max_mcq": 4},
        {"concurrency": 0},
        {"concurrency": 13},
        {"global_watchdog_s": 0},
        {"model": "gpt-not-a-model"},
        {"team": "a team\nwith a second line"},
        {"disabled_tools": ["submit_locations"]},
        {"standard": {"soft_deadline_s": 900, "hard_deadline_s": 60}},
        {"standard": {"max_turns": 0}},
        {"standard": {"bonus": 1}},
        {"hedge": "yes"},
        ["hedge"],
    ],
)
async def test_an_invalid_default_is_refused(tmp_path: Path, defaults: Any) -> None:
    ws = workspace(tmp_path)
    async with api(ws) as http:
        put = await http.put("/api/settings", json={"defaults": defaults})
    assert put.status_code == 422
    assert detail(put)["code"] == "invalid_setting" and detail(put)["problems"]
    assert ws.store.defaults() == {}


async def test_put_settings_refuses_what_is_not_a_section(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    async with api(ws) as http:
        unknown = await http.put("/api/settings", json={"defaults": {"hedge": True}, "keys": {"OPENAI_API_KEY": "x"}})
        assert unknown.status_code == 422 and detail(unknown)["code"] == "unknown_setting"
        assert ws.store.defaults() == {}  # the valid half was not saved either
        assert (await http.put("/api/settings", json=["defaults"])).status_code == 422
        broken = await http.put("/api/settings", content=b"{not json", headers={"Content-Type": "application/json"})
        assert broken.status_code == 422 and detail(broken)["code"] == "invalid_json"


async def test_an_organiser_answer_changes_the_default_it_controls(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    set_keys(monkeypatch, "GOOGLE_MAPS_API_KEY")
    ws = workspace(tmp_path)
    pasted = f"They said no on Saturday 14:05; someone pasted {SECRETS['GOOGLE_MAPS_API_KEY']} here"
    async with api(ws) as http:
        put = await http.put(
            "/api/settings",
            json={
                "organiser_answers": [
                    {"id": "Q1", "value": False, "note": pasted},
                    {"id": "Q2", "value": "subsequent"},
                    {"id": "Q5", "note": "UTC, confirmed at the desk"},
                ]
            },
        )
        assert put.status_code == 200
        body = keyless(put).json()
        rows = {row["id"]: row for row in body["organiser_answers"]}
        # the answer and the default are one stored value
        assert rows["Q1"]["value"] is False and body["defaults"]["allow_web"] is False
        assert rows["Q2"]["value"] == "subsequent" and body["defaults"]["penalty_scope"] == "subsequent"
        assert rows["Q1"]["note"].startswith("They said no") and REDACTED in rows["Q1"]["note"]
        assert rows["Q1"]["noted_at"] and rows["Q5"]["note"] == "UTC, confirmed at the desk"
        assert rows["Q3"]["note"] == "" and rows["Q3"]["noted_at"] is None
        assert ws.build_settings().allow_web is False

        # the same value seen from the other side
        flipped = (await http.put("/api/settings", json={"defaults": {"allow_web": True}})).json()
        assert {row["id"]: row for row in flipped["organiser_answers"]}["Q1"]["value"] is True

        for items in ([{"id": "Q5", "value": True}], [{"id": "Q13", "note": "x"}], [{"id": "Q2", "value": "half"}]):
            refused = await http.put("/api/settings", json={"organiser_answers": items})
            assert refused.status_code == 422 and detail(refused)["problems"]
        assert (await http.put("/api/settings", json={"organiser_answers": {"Q1": True}})).status_code == 422


async def test_directories_apply_at_the_next_start(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    usb = tmp_path / "usb"
    usb.mkdir()
    elsewhere = tmp_path / "runs-on-the-big-disk"
    async with api(ws) as http:
        put = await http.put(
            "/api/settings", json={"paths": {"runs_dir": str(elsewhere), "allowed_roots": [str(usb)]}}
        )
        assert put.status_code == 200
        body = put.json()
        assert body["restart_required"] == ["runs_dir"]
        # the directory in force is still the one this server started with
        assert body["paths"]["runs_dir"] == str((tmp_path / "runs").resolve())
        assert body["paths"]["saved"] == {"runs_dir": str(elsewhere), "cache_dir": None}
        assert str(usb.resolve()) in body["paths"]["allowed_roots"]
        assert ws.runs_dir == tmp_path / "runs" and ws.build_settings().runs_dir == tmp_path / "runs"
        assert ConsoleStore(tmp_path / "data").paths()["runs_dir"] == str(elsewhere)

        # saving the directory already in force asks for no restart
        same = (await http.put("/api/settings", json={"paths": {"runs_dir": str(tmp_path / "runs")}})).json()
        assert same["restart_required"] == []
        both = (await http.put("/api/settings", json={"paths": {"cache_dir": str(tmp_path / "c2")}})).json()
        assert both["restart_required"] == ["cache_dir"]
        cleared = (await http.put("/api/settings", json={"paths": {"cache_dir": None, "runs_dir": None}})).json()
        assert cleared["restart_required"] == [] and cleared["paths"]["saved"] == {"runs_dir": None, "cache_dir": None}

        for paths in (
            {"allowed_roots": [str(tmp_path / "runs")]},  # would show the runs
            {"allowed_roots": ["/"]},
            {"allowed_roots": [str(tmp_path / "missing")]},
            {"runs_dir": "relative/runs"},
            {"env_path": str(tmp_path / "other.env")},
            [str(usb)],
        ):
            (tmp_path / "runs").mkdir(exist_ok=True)
            refused = await http.put("/api/settings", json={"paths": paths})
            assert refused.status_code == 422, paths
        assert str(usb.resolve()) in (await http.get("/api/settings")).json()["paths"]["allowed_roots"]


async def test_a_directory_saved_before_the_start_and_reset_since_needs_a_restart(tmp_path: Path) -> None:
    ConsoleStore(tmp_path / "data").set_paths({"runs_dir": str(tmp_path / "runs")})
    ws = workspace(tmp_path)
    async with api(ws) as http:
        assert (await http.get("/api/settings")).json()["restart_required"] == []
        reset = (await http.put("/api/settings", json={"paths": {"runs_dir": None}})).json()
        assert reset["restart_required"] == ["runs_dir"]  # the next start reads the environment again


async def test_a_refused_section_leaves_the_whole_request_unsaved(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    async with api(ws) as http:
        # every section is checked before any is written, also the two only the store can judge
        for bad in (
            {"paths": {"allowed_roots": ["/"]}},
            {"lan": {"enabled": "yes"}},
            {"defaults": {"max_mcq": 9}},
        ):
            body = {"organiser_answers": [{"id": "Q5", "note": "UTC"}], "defaults": {"hedge": True}, **bad}
            put = await http.put("/api/settings", json=body)
            assert put.status_code == 422 and detail(put)["saved"] == []
            assert ws.store.defaults() == {}
            assert {row["id"]: row["note"] for row in ws.store.organiser_answers()}["Q5"] == ""
        bad_answer = await http.put(
            "/api/settings",
            json={"organiser_answers": [{"id": "Q2", "value": "sideways"}], "paths": {"runs_dir": str(tmp_path / "other")}},
        )
        assert bad_answer.status_code == 422 and ws.store.paths()["runs_dir"] is None

        saved = await http.put("/api/settings", json={"organiser_answers": [{"id": "Q5", "note": "UTC"}]})
        assert saved.status_code == 200
        assert {row["id"]: row["note"] for row in ws.store.organiser_answers()}["Q5"] == "UTC"


async def test_the_organiser_table_sent_back_whole_changes_only_what_differs(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    ws = workspace(tmp_path)
    monkeypatch.setenv("OPENAI_API_KEY", "sk-test-0123456789abcdefghij")
    async with api(ws) as http:
        table = (await http.get("/api/settings")).json()["organiser_answers"]
        rows = [{"id": row["id"], "value": row["value"], "note": row["note"]} for row in table]
        next(row for row in rows if row["id"] == "Q3")["value"] = False
        next(row for row in rows if row["id"] == "Q6")["note"] = "they said: use key sk-test-0123456789abcdefghij"
        put = await http.put("/api/settings", json={"organiser_answers": rows})
        assert put.status_code == 200 and put.json()["overridden"] == ["allow_duplicates"]
        # the untouched rows did not pin today's defaults as if the operator had chosen them
        assert ws.store.defaults() == {"allow_duplicates": False}
        # a note is free text: a key pasted into it never reaches console.json
        assert "sk-test" not in (tmp_path / "data" / "console.json").read_text(encoding="utf-8")


# ---------------------------------------------------------------------------------------------
# LAN access


async def test_lan_access_shows_its_link_to_the_server_machine_only(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    set_keys(monkeypatch)
    ws = workspace(tmp_path)
    async with api(ws) as http, api(ws, peer=LAPTOP) as laptop:
        put = await http.put("/api/settings", json={"lan": {"enabled": True}})
        assert put.status_code == 200
        body = keyless(put).json()
        token = ws.store.lan()["token"]
        assert token and len(token) >= 24
        assert body["lan"] == {
            "enabled": True,
            "token_set": True,
            "address": LAN_ADDRESS,
            "join_url": f"http://{LAN_ADDRESS}:8000/?token={token}",
        }
        assert body["restart_required"] == ["lan"]
        assert body["keys_editable"] is False
        assert ws.chips()["lan"] is True

        # a second laptop never reads the token, in any field
        seen = await laptop.get("/api/settings")
        assert seen.json()["lan"]["join_url"] is None and seen.json()["lan"]["token_set"] is True
        assert token not in seen.text

        widen = await laptop.put("/api/settings", json={"paths": {"allowed_roots": [str(tmp_path)]}})
        local_widen = await http.put("/api/settings", json={"paths": {"allowed_roots": [str(tmp_path)]}})
        switch = await laptop.put("/api/settings", json={"lan": {"enabled": False}})
        for refused in (widen, local_widen, switch):
            assert refused.status_code == 403 and detail(refused)["code"] == "lan_access_on"
            assert token not in refused.text
        assert ws.store.lan()["enabled"] is True
        # everything else stays open to it
        assert (await laptop.put("/api/settings", json={"defaults": {"hedge": True}})).status_code == 200

        off = (await http.put("/api/settings", json={"lan": {"enabled": False}})).json()
        assert off["lan"] == {"enabled": False, "token_set": False, "address": LAN_ADDRESS, "join_url": None}
        # it was never serving the LAN: nothing to restart, keys are in reach again
        assert off["restart_required"] == [] and off["keys_editable"] is True
        assert ws.chips()["lan"] is False


async def test_a_server_started_with_lan_access_keeps_keys_closed_until_it_restarts(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    set_keys(monkeypatch, "OPENAI_API_KEY")
    ConsoleStore(tmp_path / "data").set_lan(True)
    calls: list[str] = []
    ws = workspace(tmp_path, key_tester=lambda name, value, model: calls.append(name) or {"ok": True, "detail": ""})
    async with api(ws) as http, api(ws, peer=LAPTOP) as laptop:
        assert (await http.get("/api/settings")).json()["keys_editable"] is False
        for client in (http, laptop):
            put = await client.put("/api/settings/keys/OPENAI_API_KEY", json={"value": NEW_KEY})
            test = await client.post("/api/settings/keys/OPENAI_API_KEY/test")
            for refused in (put, test):
                assert refused.status_code == 403 and detail(refused)["code"] == "lan_access_on"
        assert not (tmp_path / ".env").exists() and os.environ["OPENAI_API_KEY"] == SECRETS["OPENAI_API_KEY"]
        assert calls == []

        off = (await http.put("/api/settings", json={"lan": {"enabled": False}})).json()
        # the listener is still bound to the LAN until the restart
        assert off["restart_required"] == ["lan"] and off["keys_editable"] is False
        assert (await http.put("/api/settings/keys/OPENAI_API_KEY", json={"value": NEW_KEY})).status_code == 403


async def test_the_join_link_uses_the_address_and_port_the_console_app_answers_to(tmp_path: Path) -> None:
    ConsoleStore(tmp_path / "data").set_lan(True)
    ws = workspace(tmp_path)
    token = ws.store.lan()["token"]
    # what create_console_app records: LAN in force, the host its middleware allows, its port
    async with api(ws, lan=True, lan_host="10.0.0.7", port=8123) as http:
        body = (await http.get("/api/settings")).json()
        assert body["lan"]["address"] == "10.0.0.7"
        assert body["lan"]["join_url"] == f"http://10.0.0.7:8123/?token={token}"
        assert body["restart_required"] == [] and body["keys_editable"] is False

    # the app's record of how it started wins over what is saved now
    ws = workspace(tmp_path)
    async with api(ws, lan=False, lan_host=None, port=8000) as http:
        body = (await http.get("/api/settings")).json()
        assert body["restart_required"] == ["lan"] and body["lan"]["address"] == LAN_ADDRESS


# ---------------------------------------------------------------------------------------------
# PUT /api/settings/keys/<name>

ENV_BEFORE = (
    b"# keys for the weekend\r\n"
    b"OPENAI_API_KEY=sk-first-assignment-0000\n"
    b"\n"
    b"TEAM_NAME=albatross   # ours\n"
    b"  export OPENAI_API_KEY = 'sk-old-key-11112222'\r\n"
    b"#OPENAI_API_KEY=sk-commented-out-3333\n"
    b"OPENAI_API_KEY_BACKUP=sk-not-this-one-4444\n"
    b"GOOGLE_MAPS_API_KEY=\n"
    b'MAPILLARY_TOKEN="MLY|old|token"'
)


async def test_a_key_is_written_to_env_changing_only_its_own_line(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("OPENAI_API_KEY", "sk-old-key-11112222")
    env = tmp_path / ".env"
    env.write_bytes(ENV_BEFORE)
    env.chmod(0o644)
    ws = workspace(tmp_path)
    ws.health["openai"] = True  # what a test of the old key found
    async with api(ws) as http:
        put = keyless(await http.put("/api/settings/keys/OPENAI_API_KEY", json={"value": NEW_KEY}))
        assert put.status_code == 200
        assert put.json() == {"ok": True, "set": True, "last4": NEW_KEY[-4:]}
        # the last assignment is the one a .env reader keeps: that line, with its own line ending
        assert env.read_bytes() == ENV_BEFORE.replace(
            b"  export OPENAI_API_KEY = 'sk-old-key-11112222'\r\n", f"OPENAI_API_KEY={NEW_KEY}\r\n".encode()
        )
        assert stat.S_IMODE(env.stat().st_mode) == 0o600
        assert os.environ["OPENAI_API_KEY"] == NEW_KEY
        assert ws.chips()["openai"] == {"present": True, "ok": None}
        assert [p.name for p in tmp_path.iterdir() if p.name.startswith(".")] == [".env"]  # no temp file left

        # a last line without a newline keeps none
        token = "MLY|42|feedfacefeedface"
        mapillary = keyless(await http.put("/api/settings/keys/MAPILLARY_TOKEN", json={"value": token}))
        assert mapillary.json() == {"ok": True, "set": True}
        assert env.read_bytes().endswith(f"GOOGLE_MAPS_API_KEY=\nMAPILLARY_TOKEN={token}".encode())
        assert env.read_bytes().count(b"\n") == ENV_BEFORE.count(b"\n")
        assert os.environ["MAPILLARY_TOKEN"] == token

        listed = keyless(await http.get("/api/settings")).json()["keys"]
        assert listed["OPENAI_API_KEY"] == {"set": True, "last4": NEW_KEY[-4:]}
        assert listed["MAPILLARY_TOKEN"] == {"set": True} and token not in json.dumps(listed)


async def test_a_key_the_file_does_not_have_is_appended(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    ws = workspace(tmp_path)
    google = SECRETS["GOOGLE_MAPS_API_KEY"]
    async with api(ws) as http:
        created = keyless(await http.put("/api/settings/keys/GOOGLE_MAPS_API_KEY", json={"value": google}))
        assert created.json() == {"ok": True, "set": True}
        assert env.read_bytes() == f"GOOGLE_MAPS_API_KEY={google}\n".encode()
        assert stat.S_IMODE(env.stat().st_mode) == 0o600
        assert ws.chips()["google"] == {"present": True}

        env.write_bytes(b"TEAM_NAME=albatross")  # no newline at the end
        await http.put("/api/settings/keys/GOOGLE_MAPS_API_KEY", json={"value": google})
        assert env.read_bytes() == f"TEAM_NAME=albatross\nGOOGLE_MAPS_API_KEY={google}\n".encode()


@pytest.mark.parametrize(
    "value",
    [
        "short",
        "sk-with a space-0123456789",
        "sk-two-lines-0123456789\nASTROLABIO_FAKE_MODEL=1",
        "sk-carriage-0123456789\rX=1",
        '"sk-quoted-0123456789"',
        "sk-it's-quoted-0123456789",
        "sk-comment#0123456789",
        "OPENAI_API_KEY=sk-pasted-with-its-name",
        "sk-dollar-${HOME}-0123456789",
        "sk-back\\slash-0123456789",
        "sk-nön-ascii-0123456789",
        "x" * 513,
        "",
        12345678,
        None,
        ["sk-in-a-list-0123456789"],
    ],
)
async def test_a_key_value_that_could_break_env_is_refused(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, value: Any
) -> None:
    set_keys(monkeypatch, "OPENAI_API_KEY")
    env = tmp_path / ".env"
    env.write_bytes(ENV_BEFORE)
    ws = workspace(tmp_path)
    async with api(ws) as http:
        put = await http.put("/api/settings/keys/OPENAI_API_KEY", json={"value": value})
    assert put.status_code == 422 and detail(put)["code"] == "invalid_key"
    if isinstance(value, str) and len(value) >= 8:
        assert value not in put.text  # a refused value is not echoed either
    assert env.read_bytes() == ENV_BEFORE
    assert os.environ["OPENAI_API_KEY"] == SECRETS["OPENAI_API_KEY"]


@pytest.mark.parametrize(
    "name",
    [
        "ASTROLABIO_FAKE_MODEL",
        "OPENAI_BASE_URL",
        "RUNS_DIR",
        "PATH",
        "openai_api_key",
        "OPENAI_API_KEY ",
        "OPENAI_API_KEY%0AX",
    ],
)
async def test_only_the_three_keys_can_be_written_or_tested(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, name: str
) -> None:
    before = os.environ.get(name)
    calls: list[str] = []
    ws = workspace(tmp_path, key_tester=lambda *args: calls.append(args[0]) or {"ok": True, "detail": ""})
    async with api(ws) as http:
        put = await http.put(f"/api/settings/keys/{name}", json={"value": NEW_KEY})
        test = await http.post(f"/api/settings/keys/{name}/test")
    for refused in (put, test):
        assert refused.status_code == 404 and detail(refused)["code"] == "unknown_key"
    assert os.environ.get(name) == before and not (tmp_path / ".env").exists() and calls == []


async def test_a_key_body_is_a_value_and_nothing_else(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    async with api(ws) as http:
        for body in ({"value": NEW_KEY, "name": "OPENAI_BASE_URL"}, {}, [NEW_KEY]):
            put = await http.put("/api/settings/keys/OPENAI_API_KEY", json=body)
            assert put.status_code == 422, body
            keyless(put)
    assert not (tmp_path / ".env").exists() and "OPENAI_API_KEY" not in os.environ


async def test_a_key_that_cannot_be_written_changes_nothing(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    ws = workspace(tmp_path)

    def full_disk(*args: Any) -> None:
        raise OSError(28, "No space left on device")

    monkeypatch.setattr(health.os, "replace", full_disk)
    async with api(ws) as http:
        put = await http.put("/api/settings/keys/OPENAI_API_KEY", json={"value": NEW_KEY})
    assert put.status_code == 500 and detail(put)["code"] == "env_not_writable"
    assert "OPENAI_API_KEY" not in os.environ
    assert list(tmp_path.glob(".*")) == []  # neither the file nor its temporary copy


def test_the_env_writer_refuses_names_and_values_on_its_own(tmp_path: Path) -> None:
    env = tmp_path / ".env"
    with pytest.raises(health.KeyValueError):
        health.write_env_key(env, "ASTROLABIO_FAKE_MODEL", "1" * 12)
    with pytest.raises(health.KeyValueError):
        health.write_env_key(env, "OPENAI_API_KEY", "sk-0123456789\nX=1")
    assert not env.exists()

    # a linked .env stays a link, and the file it points at gets the key
    real = tmp_path / "secrets" / "real.env"
    real.parent.mkdir()
    real.write_bytes(b"A=1\n")
    env.symlink_to(real)
    health.write_env_key(env, "OPENAI_API_KEY", NEW_KEY)
    assert env.is_symlink() and real.read_bytes() == f"A=1\nOPENAI_API_KEY={NEW_KEY}\n".encode()


# ---------------------------------------------------------------------------------------------
# POST /api/settings/keys/<name>/test


async def test_a_key_test_goes_to_the_injected_tester_and_is_redacted(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    set_keys(monkeypatch)
    calls: list[tuple[str, str, str]] = []

    async def tester(name: str, value: str, model: str) -> dict[str, Any]:
        calls.append((name, value, model))
        if name == "GOOGLE_MAPS_API_KEY":
            raise RuntimeError(f"GET https://maps.googleapis.com/x?key={value} failed: Bearer {value}")
        return {
            "ok": True,
            "detail": f"Incorrect API key provided: {value}. Authorization: Bearer {value}",
            "model_access": True,
            "reasoning_summaries": False,
            "anything_else": value,
        }

    ws = workspace(tmp_path, key_tester=tester)
    async with api(ws) as http:
        test = keyless(await http.post("/api/settings/keys/OPENAI_API_KEY/test"))
        assert test.status_code == 200
        body = test.json()
        assert set(body) == {"ok", "detail", "model_access", "reasoning_summaries", "latency_ms"}
        assert (body["ok"], body["model_access"], body["reasoning_summaries"]) == (True, True, False)
        assert REDACTED in body["detail"] and isinstance(body["latency_ms"], int)
        assert calls == [("OPENAI_API_KEY", SECRETS["OPENAI_API_KEY"], ws.build_settings().model)]
        assert ws.chips()["openai"] == {"present": True, "ok": True}

        failed = keyless(await http.post("/api/settings/keys/GOOGLE_MAPS_API_KEY/test")).json()
        assert failed["ok"] is False and "RuntimeError" in failed["detail"] and REDACTED in failed["detail"]
        assert set(failed) == {"ok", "detail", "latency_ms"}
        assert ws.chips()["openai"]["ok"] is True  # another key's test says nothing about OpenAI


async def test_a_failed_openai_test_turns_the_chip_red_and_a_missing_key_is_not_tested(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    set_keys(monkeypatch, "OPENAI_API_KEY")
    calls: list[str] = []

    def tester(name: str, value: str, model: str) -> dict[str, Any]:  # a plain function works too
        calls.append(name)
        return {"ok": False, "detail": "The key was rejected (HTTP 401).", "model_access": None}

    ws = workspace(tmp_path, key_tester=tester)
    async with api(ws) as http:
        rejected = (await http.post("/api/settings/keys/OPENAI_API_KEY/test")).json()
        assert rejected["ok"] is False and "model_access" not in rejected
        assert ws.chips()["openai"] == {"present": True, "ok": False}

        missing = await http.post("/api/settings/keys/MAPILLARY_TOKEN/test")
        assert missing.status_code == 200
        assert missing.json() == {"ok": False, "detail": "MAPILLARY_TOKEN is not set.", "latency_ms": None}
        assert calls == ["OPENAI_API_KEY"]


async def test_a_repeated_key_test_with_the_same_idempotency_key_asks_the_provider_once(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    set_keys(monkeypatch, "OPENAI_API_KEY")
    calls: list[str] = []
    ws = workspace(tmp_path, key_tester=lambda name, value, model: calls.append(name) or {"ok": True, "detail": "fine"})
    headers = {"Idempotency-Key": "settings-test-0123456789"}
    async with api(ws) as http:
        first = await http.post("/api/settings/keys/OPENAI_API_KEY/test", headers=headers)
        again = await http.post("/api/settings/keys/OPENAI_API_KEY/test", headers=headers)
        assert first.json() == again.json() and calls == ["OPENAI_API_KEY"]
        assert "idempotency-replayed" not in first.headers and again.headers["idempotency-replayed"] == "true"
        await http.post("/api/settings/keys/OPENAI_API_KEY/test")  # no key: a new test
        assert len(calls) == 2


# ---------------------------------------------------------------------------------------------
# the default tester, against a mock transport


def provider(monkeypatch: pytest.MonkeyPatch, handler: Any) -> list[httpx.Request]:
    """Route every probe to `handler(request) -> httpx.Response` and return the requests seen."""
    seen: list[httpx.Request] = []

    def handle(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return handler(request)

    monkeypatch.setattr(
        health, "make_probe_client", lambda settings: httpx.AsyncClient(transport=httpx.MockTransport(handle))
    )
    return seen


def summary_refused() -> httpx.Response:
    error = {
        "message": "Your organization must be verified to generate reasoning summaries.",
        "param": "reasoning.summary",
        "code": "unsupported_value",
    }
    return httpx.Response(400, json={"error": error})


async def test_the_openai_tester_reports_model_access_and_reasoning_summaries(monkeypatch: pytest.MonkeyPatch) -> None:
    key = SECRETS["OPENAI_API_KEY"]
    seen = provider(monkeypatch, lambda request: httpx.Response(200, json={"id": "resp_1", "status": "completed"}))
    granted = await health.default_key_tester("OPENAI_API_KEY", key, "gpt-6.1-sol")
    assert granted["ok"] and granted["model_access"] is True and granted["reasoning_summaries"] is True
    assert len(seen) == 1  # one request when nothing is refused
    request = seen[0]
    assert (request.method, str(request.url)) == ("POST", "https://api.openai.com/v1/responses")
    assert request.headers["authorization"] == f"Bearer {key}"
    sent = json.loads(request.content)
    assert sent["model"] == "gpt-6.1-sol" and sent["reasoning"] == {"effort": "low", "summary": "auto"}
    assert sent["max_output_tokens"] == 16 and sent["store"] is False and "tools" not in sent

    def unverified(request: httpx.Request) -> httpx.Response:
        asked = "summary" in json.loads(request.content)["reasoning"]
        return summary_refused() if asked else httpx.Response(200, json={"id": "resp_2"})

    seen = provider(monkeypatch, unverified)
    plain = await health.default_key_tester("OPENAI_API_KEY", key, "gpt-6.1-sol")
    assert plain["ok"] and plain["model_access"] is True and plain["reasoning_summaries"] is False
    assert "NOT granted" in plain["detail"] and len(seen) == 2

    def answer(status: int, code: str | None = None) -> Any:
        return lambda request: httpx.Response(status, json={"error": {"message": f"no: {key}", "code": code}})

    provider(monkeypatch, answer(401, "invalid_api_key"))
    rejected = await health.default_key_tester("OPENAI_API_KEY", key, "gpt-6.1-sol")
    assert not rejected["ok"] and "rejected" in rejected["detail"] and rejected["model_access"] is None

    provider(monkeypatch, answer(404, "model_not_found"))
    no_model = await health.default_key_tester("OPENAI_API_KEY", key, "gpt-6-astra")
    assert not no_model["ok"] and no_model["model_access"] is False and "gpt-6-astra" in no_model["detail"]

    provider(monkeypatch, answer(429, "insufficient_quota"))
    assert "quota" in (await health.default_key_tester("OPENAI_API_KEY", key, "gpt-6.1-sol"))["detail"]


async def test_the_default_tester_is_redacted_on_its_way_out(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    set_keys(monkeypatch, "OPENAI_API_KEY")
    key = SECRETS["OPENAI_API_KEY"]
    monkeypatch.setenv("OPENAI_BASE_URL", "https://proxy.example/v1/")
    monkeypatch.setenv("OPENAI_PROJECT_ID", "proj_albatross")
    seen = provider(
        monkeypatch,
        lambda request: httpx.Response(401, json={"error": {"message": f"Incorrect API key provided: {key}."}}),
    )
    ws = workspace(tmp_path)  # no tester injected: the default, on the mock transport
    async with api(ws) as http:
        body = keyless(await http.post("/api/settings/keys/OPENAI_API_KEY/test")).json()
    assert body["ok"] is False and REDACTED in body["detail"] and "HTTP 401" in body["detail"]
    # the same endpoint and project a run would use
    assert str(seen[0].url) == "https://proxy.example/v1/responses"
    assert seen[0].headers["openai-project"] == "proj_albatross"


async def test_the_google_and_mapillary_testers_make_one_metadata_request(monkeypatch: pytest.MonkeyPatch) -> None:
    google, mapillary = SECRETS["GOOGLE_MAPS_API_KEY"], SECRETS["MAPILLARY_TOKEN"]
    seen = provider(monkeypatch, lambda request: httpx.Response(200, json={"status": "ZERO_RESULTS"}))
    assert (await health.default_key_tester("GOOGLE_MAPS_API_KEY", google, "m"))["ok"] is True
    assert len(seen) == 1 and seen[0].url.host == "maps.googleapis.com"
    assert seen[0].url.path.endswith("/streetview/metadata") and seen[0].url.params["key"] == google

    denied = {"status": "REQUEST_DENIED", "error_message": "The provided API key is invalid."}
    provider(monkeypatch, lambda request: httpx.Response(200, json=denied))
    refused = await health.default_key_tester("GOOGLE_MAPS_API_KEY", google, "m")
    assert refused["ok"] is False and "REQUEST_DENIED" in refused["detail"] and "invalid" in refused["detail"]

    seen = provider(monkeypatch, lambda request: httpx.Response(200, json={"data": []}))
    assert (await health.default_key_tester("MAPILLARY_TOKEN", mapillary, "m"))["ok"] is True
    assert len(seen) == 1 and seen[0].url.host == "graph.mapillary.com"
    assert seen[0].headers["authorization"] == f"OAuth {mapillary}" and mapillary not in str(seen[0].url)

    bad = {"error": {"message": "Invalid OAuth access token.", "code": 190}}
    provider(monkeypatch, lambda request: httpx.Response(401, json=bad))
    refused = await health.default_key_tester("MAPILLARY_TOKEN", mapillary, "m")
    assert refused["ok"] is False and "Invalid OAuth" in refused["detail"]


# ---------------------------------------------------------------------------------------------
# GET /api/health

SERVICES = ["OpenAI", "Nominatim", "Photon", "Overpass 1", "Overpass 2", "Esri imagery", "Google", "Mapillary"]


def up(request: httpx.Request) -> httpx.Response:
    host = request.url.host
    if host == "maps.googleapis.com":
        return httpx.Response(200, json={"status": "OK"})
    if host == "api.openai.com":
        return httpx.Response(200 if "authorization" in request.headers else 401, json={"id": "gpt-6.1-sol"})
    if host == "graph.mapillary.com":
        return httpx.Response(200 if "authorization" in request.headers else 400, json={"data": []})
    return httpx.Response(200, json={"status": 0})


async def test_health_probes_every_service_and_counts_the_disk(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    set_keys(monkeypatch)
    seen = provider(monkeypatch, up)
    ws = workspace(tmp_path)
    for path, size in (
        ("runs/r1/a.events.jsonl", 1000),
        ("runs/r1/a/images/x.jpg", 234),
        ("data/sets/s1/files/p.jpg", 500),
        ("data/console.json", 77),  # not an upload
        ("cache/http/ab/abcd.bin", 300),
        ("cache/http/ab/abcd.json", 40),
        ("cache/previews/p.jpg", 9999),  # not the HTTP cache
    ):
        (tmp_path / path).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / path).write_bytes(b"x" * size)

    async with api(ws) as http:
        got = keyless(await http.get("/api/health"))
        assert got.status_code == 200
        body = got.json()

        assert [row["name"] for row in body["services"]] == SERVICES
        for row in body["services"]:
            assert set(row) == {"name", "url", "ok", "latency_ms", "detail", "checked"}
            assert row["ok"] is True and row["checked"] is True and isinstance(row["latency_ms"], int), row
            assert row["detail"], row
        assert len(seen) == len(SERVICES) and {request.method for request in seen} == {"GET"}
        asked = {request.url.host: request for request in seen}
        assert set(asked) == {
            "api.openai.com",
            "nominatim.openstreetmap.org",
            "photon.komoot.io",
            "overpass-api.de",
            "overpass.kumi.systems",
            "server.arcgisonline.com",
            "maps.googleapis.com",
            "graph.mapillary.com",
        }
        # the OpenAI probe is a model lookup, which costs nothing
        assert asked["api.openai.com"].url.path == f"/v1/models/{ws.build_settings().model}"
        assert asked["api.openai.com"].headers["authorization"] == f"Bearer {SECRETS['OPENAI_API_KEY']}"
        assert asked["maps.googleapis.com"].url.params["key"] == SECRETS["GOOGLE_MAPS_API_KEY"]
        assert asked["overpass-api.de"].url.path == "/api/status"
        assert asked["server.arcgisonline.com"].url.path.endswith("/World_Imagery/MapServer")

        assert body["window"] == ws.metrics_window() and body["window"]["minutes"] == 15
        assert {"api_retries", "api_errors", "timeouts", "median_turn_latency_ms", "mean_upload_chars"} <= set(
            body["window"]
        )
        disk = body["disk"]
        assert (disk["runs_bytes"], disk["uploads_bytes"], disk["cache_bytes"]) == (1234, 500, 340)
        assert disk["free_bytes"] > 0
        version = body["version"]
        assert set(version) == {"git_sha", "model", "sdk", "python"}
        assert version["model"] == ws.build_settings().model and version["sdk"].startswith("openai ")
        assert body["checked_at"].endswith("Z")
        assert ws.chips()["openai"]["ok"] is True and ws.chips()["internet"] == {"ok": True}

        # tabs polling together share one round of probes; the button asks again
        assert (await http.get("/api/health")).json()["checked_at"] == body["checked_at"]
        assert len(seen) == len(SERVICES)
        assert (await http.get("/api/health?refresh=1")).status_code == 200
        assert len(seen) == 2 * len(SERVICES)


async def test_health_says_what_is_down_without_leaking_a_key(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    set_keys(monkeypatch)
    google = SECRETS["GOOGLE_MAPS_API_KEY"]

    def venue_wifi(request: httpx.Request) -> httpx.Response:
        host = request.url.host
        if host == "api.openai.com":
            return httpx.Response(401, json={"error": {"message": "Incorrect API key provided"}})
        if host == "maps.googleapis.com":
            raise httpx.ConnectError(f"connection refused for {request.url}")  # the URL carries the key
        if host == "graph.mapillary.com":
            return httpx.Response(401, json={"error": {"message": "Invalid OAuth access token."}})
        if host == "photon.komoot.io":
            return httpx.Response(200, json={"features": []})
        return httpx.Response(503)

    provider(monkeypatch, venue_wifi)
    ws = workspace(tmp_path)
    async with api(ws) as http:
        body = keyless(await http.get("/api/health")).json()
    rows = {row["name"]: row for row in body["services"]}
    assert {name for name, row in rows.items() if row["ok"]} == {"Photon"}
    assert "rejected" in rows["OpenAI"]["detail"]
    assert rows["Nominatim"]["detail"] == "HTTP 503" and isinstance(rows["Nominatim"]["latency_ms"], int)
    assert rows["Google"]["latency_ms"] is None
    assert "ConnectError" in rows["Google"]["detail"] and REDACTED in rows["Google"]["detail"]
    assert google not in json.dumps(body)
    assert "Invalid OAuth" in rows["Mapillary"]["detail"]
    # one public service answered: the internet is there, the OpenAI key is not working
    assert ws.chips()["internet"] == {"ok": True} and ws.chips()["openai"] == {"present": True, "ok": False}
    assert (body["disk"]["runs_bytes"], body["disk"]["uploads_bytes"], body["disk"]["cache_bytes"]) == (0, 0, 0)


async def test_health_without_keys_or_network(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    def unplugged(request: httpx.Request) -> httpx.Response:
        raise httpx.ConnectError("no route to host")

    seen = provider(monkeypatch, unplugged)
    ws = workspace(tmp_path)
    async with api(ws) as http:
        body = (await http.get("/api/health")).json()
    assert [row["ok"] for row in body["services"]] == [False] * len(SERVICES)
    assert all(row["latency_ms"] is None and "Not reachable" in row["detail"] for row in body["services"])
    assert ws.chips()["internet"] == {"ok": False}
    assert ws.chips()["openai"] == {"present": False, "ok": None}  # no key: nothing was learnt about one
    assert all("authorization" not in request.headers and "key" not in request.url.params for request in seen)

    provider(monkeypatch, up)
    async with api(ws) as http:
        rows = {row["name"]: row for row in (await http.get("/api/health?refresh=true")).json()["services"]}
    # reachable is all an optional service without a key can be; OpenAI without one is not usable
    assert rows["Google"]["ok"] and "no key is set" in rows["Google"]["detail"]
    assert rows["Mapillary"]["ok"] and "no token is set" in rows["Mapillary"]["detail"]
    assert not rows["OpenAI"]["ok"] and "OPENAI_API_KEY is not set" in rows["OpenAI"]["detail"]
    assert ws.chips()["internet"] == {"ok": True} and ws.chips()["openai"]["ok"] is None


async def test_a_service_that_never_answers_is_cut_off(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    async def hang(request: httpx.Request) -> httpx.Response:
        if request.url.host == "photon.komoot.io":
            await asyncio.sleep(30)
        return up(request)

    monkeypatch.setattr(health, "PROBE_TIMEOUT_S", 0.05)
    monkeypatch.setattr(
        health, "make_probe_client", lambda settings: httpx.AsyncClient(transport=httpx.MockTransport(hang))
    )
    ws = workspace(tmp_path)
    async with api(ws) as http:
        rows = {row["name"]: row for row in (await http.get("/api/health")).json()["services"]}
    assert rows["Photon"]["ok"] is False and rows["Photon"]["detail"].startswith("No answer within")
    assert rows["Nominatim"]["ok"] is True


async def test_health_follows_the_service_urls_of_the_settings(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    seen = provider(monkeypatch, up)
    ws = workspace(
        tmp_path,
        nominatim_url="https://nominatim.example/",
        overpass_urls=("https://one.example/api/interpreter", "https://two.example/custom", "https://three.example/q"),
    )
    async with api(ws) as http:
        body = (await http.get("/api/health")).json()
    names = [row["name"] for row in body["services"]]
    assert names[3:6] == ["Overpass 1", "Overpass 2", "Overpass 3"]
    urls = {str(request.url) for request in seen}
    assert "https://nominatim.example/status?format=json" in urls
    assert {"https://one.example/api/status", "https://two.example/custom", "https://three.example/q"} <= urls


# ---------------------------------------------------------------------------------------------
# POST /api/cache/clear


async def test_clearing_the_cache_needs_confirmation_and_removes_only_http_responses(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    for path, size in (("http/ab/abcd.bin", 300), ("http/cd/cdef.json", 40), ("previews/p.jpg", 55)):
        (tmp_path / "cache" / path).parent.mkdir(parents=True, exist_ok=True)
        (tmp_path / "cache" / path).write_bytes(b"x" * size)
    (tmp_path / "runs").mkdir()
    (tmp_path / "runs" / "keep.txt").write_bytes(b"run")

    async with api(ws) as http:
        for body in ({}, {"confirm": False}, {"confirm": "true"}, {"confirm": 1}):
            unconfirmed = await http.post("/api/cache/clear", json=body)
            assert unconfirmed.status_code == 422 and detail(unconfirmed)["code"] == "confirm_required"
        assert (tmp_path / "cache" / "http" / "ab" / "abcd.bin").exists()

        cleared = await http.post("/api/cache/clear", json={"confirm": True})
        assert cleared.status_code == 200 and cleared.json() == {"ok": True, "removed_bytes": 340}
        assert not (tmp_path / "cache" / "http").exists()
        assert (tmp_path / "cache" / "previews" / "p.jpg").read_bytes() == b"x" * 55
        assert (tmp_path / "runs" / "keep.txt").exists()

        again = await http.post("/api/cache/clear", json={"confirm": True})
        assert again.json() == {"ok": True, "removed_bytes": 0}


async def test_a_cache_directory_that_is_a_link_is_left_alone(tmp_path: Path) -> None:
    ws = workspace(tmp_path)
    precious = tmp_path / "runs"
    precious.mkdir()
    (precious / "answers.csv").write_bytes(b"lat,lng\n")
    (tmp_path / "cache").mkdir()
    (tmp_path / "cache" / "http").symlink_to(precious, target_is_directory=True)
    async with api(ws) as http:
        refused = await http.post("/api/cache/clear", json={"confirm": True})
    assert refused.status_code == 403 and detail(refused)["code"] == "forbidden_path"
    assert (precious / "answers.csv").read_bytes() == b"lat,lng\n"
