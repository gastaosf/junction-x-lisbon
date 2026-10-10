from __future__ import annotations

import asyncio
import json
from pathlib import Path

import pytest

from geoagent.config import Settings
from geoagent.eventlog import export_panorama, validate_export
from geoagent.schema import Hypothesis, Label, PanoramaTask
from geoagent.session import HumanChannelError, McqRefused, PanoramaSession
from geoagent.tools.base import ToolContext
from geoagent.tools.candidates import run_ask_multiple_choice, run_submit_locations, run_update_candidates

LISBON = (38.722252, -9.139337)
PORTO = (41.149610, -8.610990)
VISUAL_CUE = "The white bollards with a red reflective band stand on the right side of the road."


def make_session(tmp_path: Path, *, label: Label = Label.URBAN, special: bool = False, **overrides) -> PanoramaSession:
    settings = Settings(runs_dir=tmp_path / "runs", mcq_timeout_s=overrides.pop("mcq_timeout_s", 0.05), **overrides)
    task = PanoramaTask(panorama_id="pano1", path=tmp_path / "pano1.jpg", label=label, special=special)
    return PanoramaSession(task, settings, "run1")


def hyp(point: tuple[float, float], p: float, label: str = "") -> Hypothesis:
    return Hypothesis(lat=point[0], lng=point[1], probability=p, radius_m=50, label=label, evidence="e")


def two_hyps() -> list[Hypothesis]:
    return [hyp(LISBON, 0.7, "Baixa, Lisboa"), hyp(PORTO, 0.3, "Ribeira, Porto")]


def types(session: PanoramaSession) -> list[str]:
    return [e["type"] for e in session.log.events()]


def last(session: PanoramaSession, type: str) -> dict:
    return [e for e in session.log.events() if e["type"] == type][-1]


def points(entries) -> set[tuple[float, float]]:
    return {(e.lat, e.lng) for e in entries}


async def ask_and_answer(session: PanoramaSession, index: int = 1) -> dict:
    task = asyncio.create_task(session.ask_mcq("Which street matches?", ["A", "B", "C"], "splits the modes"))
    await asyncio.sleep(0)
    session.answer_mcq(session.pending_mcq["id"], index)
    return await task


def ctx(session: PanoramaSession) -> ToolContext:
    return ToolContext(session=session, pano=None, settings=session.settings, http=None)  # type: ignore[arg-type]


# ---------------------------------------------------------------- layout, candidates, final answer


def test_paths_and_initial_state(tmp_path):
    session = make_session(tmp_path)
    assert session.log.path == tmp_path / "runs" / "run1" / "pano1.events.jsonl"
    assert session.image_dir == tmp_path / "runs" / "run1" / "pano1" / "images"
    assert session.image_dir.is_dir()
    assert (session.status, session.final, session.provisional, session.hypotheses) == ("pending", None, [], [])
    assert session.mcq_allowed is True
    assert session.elapsed_s() >= 0


def test_update_candidates_persists_a_provisional_list(tmp_path):
    session = make_session(tmp_path)
    entries = session.update_candidates(two_hyps())
    assert len(entries) == 10 and [e.rank for e in entries] == list(range(1, 11))
    assert points(entries) == {LISBON}
    assert all(e.multiplier == 1.0 and e.origin == "agent" for e in entries)
    assert session.provisional == entries
    assert session.named_places == ["Baixa, Lisboa", "Ribeira, Porto"]
    event = last(session, "candidates_update")
    assert event["actor"] == "agent"
    assert len(event["data"]["hypotheses"]) == 2
    assert len(event["data"]["provisional"]) == 10
    assert event["data"]["allocator"]["plan"] == "10x1"
    # the list is already on disk, so a crash right now still leaves an answer to submit
    assert json.loads(session.log.path.read_text().splitlines()[-1])["type"] == "candidates_update"


def test_update_candidates_validates_and_dedupes_named_places(tmp_path):
    session = make_session(tmp_path)
    with pytest.raises(ValueError):
        session.update_candidates([])
    with pytest.raises(ValueError):
        session.update_candidates([hyp(LISBON, 0.05)] * 11)
    with pytest.raises(ValueError):
        session.update_candidates([{"lat": 95.0, "lng": 0.0, "probability": 0.5}])
    assert session.provisional == [] and "candidates_update" not in types(session)
    session.update_candidates(two_hyps())
    session.update_candidates([hyp(PORTO, 0.9, "Ribeira, Porto"), hyp(LISBON, 0.1, "")])
    assert session.named_places == ["Baixa, Lisboa", "Ribeira, Porto"]
    assert points(session.provisional) == {PORTO}


def test_hedge_setting_reaches_the_allocator(tmp_path):
    session = make_session(tmp_path, hedge=True)
    entries = session.update_candidates([hyp(LISBON, 0.5), hyp(PORTO, 0.5)])
    assert points(entries) == {LISBON, PORTO}
    assert last(session, "candidates_update")["data"]["allocator"]["hedge"] is True


def test_finalize_is_idempotent(tmp_path):
    session = make_session(tmp_path)
    session.update_candidates(two_hyps())
    first = session.finalize(reason="hard_deadline")
    second = session.finalize("harness_fallback", hypotheses=[hyp(PORTO, 1.0)], reason="again")
    assert second is first
    assert session.status == "done"
    assert points(first) == {LISBON} and all(e.origin == "agent" for e in first)
    assert types(session).count("final_submission") == 1
    data = last(session, "final_submission")["data"]
    assert data["origin"] == "agent" and data["reason"] == "hard_deadline"
    assert len(data["entries"]) == 10 and data["allocator"]["plan"] == "10x1"
    with pytest.raises(ValueError):
        session.update_candidates(two_hyps())


@pytest.mark.parametrize("label", [Label.URBAN, Label.NON_URBAN])
def test_finalize_without_hypotheses_submits_the_prior(tmp_path, label):
    session = make_session(tmp_path, label=label)
    entries = session.finalize(reason="crash")
    assert len(entries) == 10
    assert points(entries) == {session.settings.prior_for(label)}
    assert all(e.origin == "harness_fallback" and e.multiplier == 1.0 for e in entries)
    data = last(session, "final_submission")["data"]
    assert data["origin"] == "harness_fallback" and data["reason"] == "crash"


def test_finalize_with_given_hypotheses_and_bad_input(tmp_path):
    session = make_session(tmp_path)
    session.update_candidates(two_hyps())
    with pytest.raises(ValueError):
        session.finalize(hypotheses=[])
    assert session.final is None and session.status == "pending"
    entries = session.finalize("agent", hypotheses=[hyp(PORTO, 1.0, "Porto")], reasoning_summary="azulejos", reason="submit")
    assert points(entries) == {PORTO}
    assert last(session, "final_submission")["data"]["reasoning_summary"] == "azulejos"
    assert "Porto" in session.named_places


def test_distinct_entries_when_duplicates_are_disallowed(tmp_path):
    session = make_session(tmp_path, allow_duplicates=False)
    assert len(points(session.finalize())) == 10


def test_a_cue_restamps_the_provisional_list_at_once(tmp_path):
    """R9, whole_list scope: the list on screen must carry the multiplier it would be submitted with."""
    session = make_session(tmp_path)
    session.update_candidates(two_hyps())
    session.submit_cue(VISUAL_CUE, confirmed=True)
    assert all(e.multiplier == pytest.approx(0.8) for e in session.provisional)
    assert {e["multiplier"] for e in session.snapshot()["provisional"]} == {0.8}
    assert all(e.origin == "agent" for e in session.provisional)
    assert all(e.multiplier == pytest.approx(0.8) for e in session.finalize())


async def test_a_question_restamps_the_provisional_list_at_once(tmp_path):
    session = make_session(tmp_path)
    session.update_candidates(two_hyps())
    await session.ask_mcq("Which street matches?", ["A", "B"], "splits the modes")
    assert {e.multiplier for e in session.provisional} == {0.95}


def test_subsequent_scope_provisional_keeps_the_earlier_multiplier_after_a_cue(tmp_path):
    session = make_session(tmp_path, penalty_scope="subsequent")
    session.update_candidates(two_hyps())
    session.submit_cue(VISUAL_CUE, confirmed=True)
    assert all(e.multiplier == 1.0 for e in session.provisional)


def test_subsequent_scope_keeps_the_multiplier_of_unchanged_slots(tmp_path):
    session = make_session(tmp_path, penalty_scope="subsequent")
    session.update_candidates(two_hyps())
    session.submit_cue(VISUAL_CUE, confirmed=True)
    assert all(e.multiplier == 1.0 for e in session.update_candidates(two_hyps()))
    moved = session.finalize(hypotheses=[hyp(PORTO, 1.0)])
    assert all(e.multiplier == pytest.approx(0.8) for e in moved)


# ---------------------------------------------------------------- MCQ (R7)


async def test_mcq_penalty_is_applied_when_asked(tmp_path):
    session = make_session(tmp_path, mcq_timeout_s=5)
    session.status = "running"
    task = asyncio.create_task(session.ask_mcq("Which street?", ["A", "B", "C"], "splits Lisbon from Porto"))
    await asyncio.sleep(0)
    assert session.status == "awaiting_mcq"
    assert session.ledger.mcqs == 1 and session.ledger.multiplier == pytest.approx(0.95)
    pending = session.pending_mcq
    assert pending["question"] == "Which street?" and pending["options"] == ["A", "B", "C"]
    assert {"id", "why_it_matters", "asked_at"} <= set(pending)
    asked = last(session, "mcq_asked")
    assert asked["actor"] == "agent"
    assert asked["penalty_state"]["mcqs"] == 1
    assert (asked["data"]["multiplier_before"], asked["data"]["multiplier_after"]) == (1.0, pytest.approx(0.95))

    session.answer_mcq(pending["id"], 2)
    assert await task == {"answered": True, "selected_index": 2, "selected_option": "C"}
    assert session.pending_mcq is None and session.status == "running"
    answered = last(session, "mcq_answered")
    assert answered["actor"] == "human"
    assert answered["data"]["selected_index"] == 2 and answered["data"]["selected_option"] == "C"
    assert answered["data"]["multiplier_after"] == pytest.approx(0.95)
    assert session.ledger.mcqs == 1


async def test_mcq_timeout_means_no_answer_but_still_costs(tmp_path):
    session = make_session(tmp_path)
    result = await session.ask_mcq("Which?", ["A", "B"], "why")
    assert result == {"answered": False, "selected_index": None, "selected_option": None}
    assert session.ledger.multiplier == pytest.approx(0.95)
    answered = last(session, "mcq_answered")
    assert answered["actor"] == "harness" and answered["data"]["selected_index"] is None
    assert session.pending_mcq is None and session.status == "pending"


async def test_mcq_tool_reports_no_answer_proceed_on_timeout(tmp_path):
    session = make_session(tmp_path)
    result = await run_ask_multiple_choice(ctx(session), {"question": "Which?", "options": ["A", "B"], "why_it_matters": "w"})
    assert not result.is_error
    assert result.content[0]["text"].lower().startswith("no answer; proceed")
    assert result.log["answered"] is False


@pytest.mark.parametrize(
    "overrides, options",
    [
        ({"no_human": True}, ["A", "B"]),
        ({"mcq_allowed": False}, ["A", "B"]),
        ({}, ["only one"]),
        ({}, ["A", "B", "C", "D", "E"]),
        ({}, ["A", " "]),
    ],
)
async def test_mcq_refusals_cost_nothing(tmp_path, overrides, options):
    session = make_session(tmp_path, **overrides)
    with pytest.raises(McqRefused):
        await session.ask_mcq("Which?", options, "why")
    assert session.ledger.mcqs == 0 and session.ledger.multiplier == 1.0
    assert session.pending_mcq is None and "mcq_asked" not in types(session)
    result = await run_ask_multiple_choice(ctx(session), {"question": "Which?", "options": options, "why_it_matters": "w"})
    assert result.is_error and "no penalty" in result.content[0]["text"]
    assert session.ledger.multiplier == 1.0


async def test_mcq_refused_by_operator_toggle_and_when_final(tmp_path):
    session = make_session(tmp_path)
    session.set_mcq_allowed(False)
    with pytest.raises(McqRefused):
        await session.ask_mcq("Which?", ["A", "B"], "why")
    session.set_mcq_allowed(True)
    session.finalize()
    with pytest.raises(McqRefused):
        await session.ask_mcq("Which?", ["A", "B"], "why")
    assert session.ledger.mcqs == 0


async def test_mcq_limit_is_three(tmp_path):
    session = make_session(tmp_path, mcq_timeout_s=5)
    for _ in range(3):
        assert (await ask_and_answer(session))["answered"]
    assert session.ledger.multiplier == pytest.approx(0.95**3)
    with pytest.raises(McqRefused):
        await session.ask_mcq("One more?", ["A", "B"], "why")
    assert session.ledger.mcqs == 3 and session.ledger.multiplier == pytest.approx(0.95**3)
    assert types(session).count("mcq_asked") == 3


async def test_only_one_mcq_can_be_pending(tmp_path):
    session = make_session(tmp_path, mcq_timeout_s=5)
    first = asyncio.create_task(session.ask_mcq("First?", ["A", "B"], "why"))
    await asyncio.sleep(0)
    with pytest.raises(McqRefused):
        await session.ask_mcq("Second?", ["A", "B"], "why")
    assert session.ledger.mcqs == 1
    session.answer_mcq(session.pending_mcq["id"], 0)
    await first


async def test_answer_mcq_rejects_stale_ids_bad_indices_and_double_clicks(tmp_path):
    session = make_session(tmp_path, mcq_timeout_s=5)
    with pytest.raises(HumanChannelError):
        session.answer_mcq("nothing-open", 0)
    task = asyncio.create_task(session.ask_mcq("Which?", ["A", "B"], "why"))
    await asyncio.sleep(0)
    mcq_id = session.pending_mcq["id"]
    for bad_id, bad_index in [("stale", 0), (mcq_id, 2), (mcq_id, -1)]:
        with pytest.raises(HumanChannelError):
            session.answer_mcq(bad_id, bad_index)
    session.answer_mcq(mcq_id, 0)
    with pytest.raises(HumanChannelError):
        session.answer_mcq(mcq_id, 1)
    assert (await task)["selected_index"] == 0
    with pytest.raises(HumanChannelError):
        session.answer_mcq(mcq_id, 0)


async def test_mcq_can_be_answered_from_a_worker_thread(tmp_path):
    session = make_session(tmp_path, mcq_timeout_s=5)
    task = asyncio.create_task(session.ask_mcq("Which?", ["A", "B"], "why"))
    await asyncio.sleep(0)
    await asyncio.to_thread(session.answer_mcq, session.pending_mcq["id"], 1)
    assert (await task)["selected_option"] == "B"


async def test_finalize_releases_a_pending_mcq(tmp_path):
    session = make_session(tmp_path, mcq_timeout_s=5)
    task = asyncio.create_task(session.ask_mcq("Which?", ["A", "B"], "why"))
    await asyncio.sleep(0)
    entries = session.finalize(reason="watchdog")
    assert (await asyncio.wait_for(task, 1))["answered"] is False
    assert session.status == "done" and session.pending_mcq is None
    # the question was asked before the list was fixed, so the list carries its cost
    assert all(e.multiplier == pytest.approx(0.95) for e in entries)


# ---------------------------------------------------------------- cue (R6)


def test_cue_costs_point_eight_and_is_queued(tmp_path):
    session = make_session(tmp_path)
    preview = session.submit_cue(VISUAL_CUE)
    assert preview["accepted"] is False and preview["needs_confirmation"] is True
    assert (preview["multiplier_before"], preview["multiplier_after"]) == (1.0, pytest.approx(0.8))
    assert session.ledger.cues == 0 and session.drain_cues() == [] and "human_cue" not in types(session)

    result = session.submit_cue(VISUAL_CUE, confirmed=True)
    assert result["accepted"] is True
    assert (result["multiplier_before"], result["multiplier_after"]) == (1.0, pytest.approx(0.8))
    assert session.ledger.cues == 1 and session.ledger.multiplier == pytest.approx(0.8)
    event = last(session, "human_cue")
    assert event["actor"] == "human"
    assert event["data"]["text"] == VISUAL_CUE and event["data"]["char_count"] == len(VISUAL_CUE)
    assert event["data"]["lint"]["ok"] is True
    assert event["data"]["multiplier_after"] == pytest.approx(0.8)
    assert event["penalty_state"]["cues"] == 1
    assert session.drain_cues() == [VISUAL_CUE]
    assert session.drain_cues() == []


def test_cue_length_cap(tmp_path):
    session = make_session(tmp_path)
    at_limit = ("grey stone wall " * 100)[:1000].strip().ljust(1000, "a")
    assert len(at_limit) == 1000
    assert session.submit_cue(at_limit)["char_count"] == 1000
    with pytest.raises(HumanChannelError, match="1001"):
        session.submit_cue(at_limit + "a", confirmed=True)
    for empty in ["", "   \n"]:
        with pytest.raises(HumanChannelError):
            session.submit_cue(empty, confirmed=True)
    assert session.ledger.cues == 0 and session.drain_cues() == []


@pytest.mark.parametrize(
    "text",
    [
        "Look near Lisboa, by the river.",
        "The camera is at 38.7223, -9.1393.",
        "This is clearly in Portugal.",
    ],
)
def test_cue_referring_to_a_location_is_blocked(tmp_path, text):
    session = make_session(tmp_path)
    for confirmed in (False, True):
        with pytest.raises(HumanChannelError) as err:
            session.submit_cue(text, confirmed=confirmed)
        assert err.value.lint is not None and err.value.lint["ok"] is False and err.value.lint["problems"]
    assert session.ledger.cues == 0 and session.ledger.multiplier == 1.0
    assert session.drain_cues() == [] and "human_cue" not in types(session)
    rejected = last(session, "human_cue_rejected")
    assert rejected["data"]["delivered_to_agent"] is False and rejected["penalty_state"]["cues"] == 0


def test_cue_refused_once_final(tmp_path):
    session = make_session(tmp_path)
    session.finalize()
    with pytest.raises(HumanChannelError):
        session.submit_cue(VISUAL_CUE, confirmed=True)
    assert session.ledger.cues == 0


# ---------------------------------------------------------------- last-resort geocode (R8)


def test_human_geocode_only_for_a_place_the_agent_named(tmp_path):
    session = make_session(tmp_path)
    with pytest.raises(HumanChannelError):
        session.human_geocode(38.7, -9.1, "Baixa, Lisboa")
    session.update_candidates(two_hyps())
    with pytest.raises(HumanChannelError):
        session.human_geocode(38.7, -9.1, "Somewhere the operator made up")
    with pytest.raises(HumanChannelError):
        session.human_geocode(98.7, -9.1, "Baixa, Lisboa")
    assert session.ledger.human_geocodes == 0 and "human_geocode" not in types(session)


def test_human_geocode_halves_and_overrides_the_answer(tmp_path):
    session = make_session(tmp_path)
    session.update_candidates(two_hyps())
    entries = session.human_geocode(38.7111114, -9.1400006, "Baixa, Lisboa")
    assert len(entries) == 10 and points(entries) == {(38.711111, -9.140001)}
    assert all(e.origin == "human_geocode" and e.multiplier == pytest.approx(0.5) for e in entries)
    assert session.provisional == entries
    event = last(session, "human_geocode")
    assert event["actor"] == "human"
    assert event["data"]["place_label"] == "Baixa, Lisboa"
    assert (event["data"]["lat"], event["data"]["lng"]) == (38.711111, -9.140001)
    assert (event["data"]["multiplier_before"], event["data"]["multiplier_after"]) == (1.0, 0.5)

    # the human point is the final answer at once: nothing the agent does afterwards can change it
    assert session.final == entries and session.status == "done"
    assert last(session, "final_submission")["data"]["origin"] == "human_geocode"
    with pytest.raises(ValueError, match="already final"):
        session.update_candidates([hyp(PORTO, 1.0, "Porto")])
    final = session.finalize("agent", hypotheses=[hyp(PORTO, 1.0, "Porto")], reason="submit_locations")
    assert final == entries
    assert all(e.origin == "human_geocode" and e.multiplier == pytest.approx(0.5) for e in final)
    assert types(session).count("final_submission") == 1


async def test_nothing_is_charged_after_a_human_geocode(tmp_path):
    """The answer is locked to the human point, so a later question or cue would be pure loss."""
    session = make_session(tmp_path)
    session.update_candidates(two_hyps())
    session.human_geocode(38.71, -9.14, "Baixa, Lisboa")

    with pytest.raises(McqRefused, match="already final"):
        await session.ask_mcq("Which street matches?", ["A", "B"], "splits the modes")
    with pytest.raises(HumanChannelError, match="already final"):
        session.submit_cue(VISUAL_CUE, confirmed=True)
    asked = await run_ask_multiple_choice(
        ctx(session), {"question": "Which?", "options": ["A", "B"], "why_it_matters": "x"}
    )
    assert asked.is_error and "no penalty" in asked.content[0]["text"]

    state = session.ledger.state()
    assert (state.cues, state.mcqs, state.human_geocodes, state.multiplier) == (0, 0, 1, 0.5)
    assert {e.multiplier for e in session.finalize()} == {0.5}
    assert "mcq_asked" not in types(session) and "human_cue" not in types(session)


async def test_human_geocode_closes_an_open_question(tmp_path):
    session = make_session(tmp_path, mcq_timeout_s=5)
    session.update_candidates(two_hyps())
    asking = asyncio.create_task(session.ask_mcq("Which street matches?", ["A", "B"], "splits the modes"))
    await asyncio.sleep(0)
    session.human_geocode(38.71, -9.14, "Baixa, Lisboa")
    answer = await asyncio.wait_for(asking, timeout=1)
    assert answer["answered"] is False and session.pending_mcq is None and session.status == "done"
    assert all(e.multiplier == pytest.approx(0.95 * 0.5) for e in session.final)


def test_cue_still_queued_at_finalize_is_logged_as_undelivered(tmp_path):
    session = make_session(tmp_path)
    session.update_candidates(two_hyps())
    session.submit_cue(VISUAL_CUE, confirmed=True)
    assert session.has_pending_cues()
    entries = session.finalize(reason="hard_deadline")
    undelivered = last(session, "human_cue_undelivered")
    assert undelivered["data"]["text"] == VISUAL_CUE and undelivered["data"]["delivered_to_agent"] is False
    assert undelivered["data"]["reason"] == "hard_deadline"
    assert types(session).index("human_cue_undelivered") < types(session).index("final_submission")
    assert {e.multiplier for e in entries} == {0.8} and not session.has_pending_cues()


def test_delivered_cue_is_not_reported_as_undelivered(tmp_path):
    session = make_session(tmp_path)
    session.submit_cue(VISUAL_CUE, confirmed=True)
    assert session.drain_cues() == [VISUAL_CUE]
    session.finalize()
    assert "human_cue_undelivered" not in types(session)


async def test_submit_locations_waits_for_a_queued_cue(tmp_path):
    session = make_session(tmp_path)
    session.submit_cue(VISUAL_CUE, confirmed=True)
    args = {"hypotheses": [hyp(PORTO, 1.0, "Porto").model_dump()], "reasoning_summary": "x"}

    deferred = await run_submit_locations(ctx(session), args)
    assert deferred.is_error and session.final is None
    assert points(session.provisional) == {PORTO}  # kept as best-so-far

    assert session.drain_cues() == [VISUAL_CUE]  # the loop hands it to the agent
    done = await run_submit_locations(ctx(session), args)
    assert not done.is_error and session.final is not None


# ---------------------------------------------------------------- reusing a run id


async def test_reused_run_id_keeps_the_penalties_already_in_the_log(tmp_path):
    first = make_session(tmp_path)
    first.update_candidates(two_hyps())
    first.submit_cue(VISUAL_CUE, confirmed=True)
    await first.ask_mcq("Which street matches?", ["A", "B"], "splits the modes")
    assert first.ledger.multiplier == pytest.approx(0.76)

    second = make_session(tmp_path)  # the server was restarted with the same --run-id
    assert second.resumed is True
    state = second.ledger.state()
    assert (state.cues, state.mcqs, state.human_geocodes) == (1, 1, 0)
    assert state.multiplier == pytest.approx(0.76)
    assert points(second.provisional) == {LISBON}  # best-so-far survives the restart too
    assert second.named_places == ["Baixa, Lisboa", "Ribeira, Porto"]
    resumed = last(second, "run_resumed")
    assert resumed["data"]["restored"]["penalty_state"]["multiplier"] == pytest.approx(0.76)

    entries = second.finalize(reason="restart")
    assert all(e.multiplier == pytest.approx(0.76) for e in entries)
    doc = export_panorama(second.log.path, tmp_path / "out.json", team="t", panorama={}, config={})
    assert doc["final"]["penalty_state"] == {"cues": 1, "mcqs": 1, "human_geocodes": 0, "multiplier": 0.76}
    assert validate_export(doc) == []


def test_reused_run_id_restores_a_human_geocode(tmp_path):
    first = make_session(tmp_path)
    first.update_candidates(two_hyps())
    first.human_geocode(38.71, -9.14, "Baixa, Lisboa")

    second = make_session(tmp_path)
    assert second.human_override == {"lat": 38.71, "lng": -9.14, "place_label": "Baixa, Lisboa"}
    final = second.finalize(reason="restart")
    assert points(final) == {(38.71, -9.14)}
    assert all(e.origin == "human_geocode" and e.multiplier == 0.5 for e in final)


def test_fresh_run_is_not_marked_resumed(tmp_path):
    session = make_session(tmp_path)
    assert session.resumed is False and "run_resumed" not in types(session)


def test_validate_export_flags_penalties_missing_from_the_final_state(tmp_path):
    session = make_session(tmp_path)
    session.update_candidates(two_hyps())
    session.submit_cue(VISUAL_CUE, confirmed=True)
    session.drain_cues()
    session.finalize()
    doc = export_panorama(session.log.path, tmp_path / "out.json", team="t", panorama={}, config={})
    assert validate_export(doc) == []
    doc["final"]["penalty_state"] = {"cues": 0, "mcqs": 0, "human_geocodes": 0, "multiplier": 1.0}
    assert any("human_cue" in problem for problem in validate_export(doc))


def test_human_geocode_after_final_re_emits_the_submission(tmp_path):
    session = make_session(tmp_path)
    session.update_candidates(two_hyps())
    session.finalize()
    entries = session.human_geocode(38.71, -9.14, "Ribeira, Porto")
    assert session.final == entries == session.finalize() and session.status == "done"
    assert types(session).count("final_submission") == 2
    final = last(session, "final_submission")
    assert final["data"]["origin"] == "human_geocode"
    assert {e["multiplier"] for e in final["data"]["entries"]} == {0.5}
    assert final["penalty_state"]["human_geocodes"] == 1


# ---------------------------------------------------------------- --no-human


async def test_no_human_disables_all_three_channels(tmp_path):
    session = make_session(tmp_path, no_human=True)
    session.update_candidates(two_hyps())
    with pytest.raises(McqRefused):
        await session.ask_mcq("Which?", ["A", "B"], "why")
    with pytest.raises(HumanChannelError):
        session.submit_cue(VISUAL_CUE, confirmed=True)
    with pytest.raises(HumanChannelError):
        session.submit_cue(VISUAL_CUE)
    with pytest.raises(HumanChannelError):
        session.human_geocode(38.7, -9.1, "Baixa, Lisboa")
    with pytest.raises(HumanChannelError):
        session.answer_mcq("any", 0)
    state = session.ledger.state()
    assert (state.cues, state.mcqs, state.human_geocodes, state.multiplier) == (0, 0, 0, 1.0)
    assert all(e.multiplier == 1.0 and e.origin == "agent" for e in session.finalize())
    assert session.snapshot()["mcq_allowed"] is False
    assert not {"mcq_asked", "human_cue", "human_geocode"} & set(types(session))


# ---------------------------------------------------------------- log, UI feed, export


async def test_every_event_carries_the_ledger_state_at_emit_time(tmp_path):
    session = make_session(tmp_path, mcq_timeout_s=5)
    session.update_candidates(two_hyps())
    await ask_and_answer(session)
    session.submit_cue(VISUAL_CUE, confirmed=True)
    session.human_geocode(38.71, -9.14, "Baixa, Lisboa")
    session.finalize()
    events = session.log.events()
    assert [e["seq"] for e in events] == list(range(1, len(events) + 1))
    by_type = {e["type"]: e["penalty_state"] for e in events}
    assert by_type["candidates_update"]["multiplier"] == 1.0
    assert by_type["mcq_asked"]["multiplier"] == pytest.approx(0.95)
    assert by_type["human_cue"]["multiplier"] == pytest.approx(0.95 * 0.8)
    assert by_type["human_geocode"]["multiplier"] == pytest.approx(0.95 * 0.8 * 0.5)
    assert by_type["final_submission"] == {
        "cues": 1,
        "mcqs": 1,
        "human_geocodes": 1,
        "multiplier": pytest.approx(0.95 * 0.8 * 0.5),
    }
    stamped = [e["multiplier"] for e in last(session, "final_submission")["data"]["entries"]]
    assert stamped == [pytest.approx(0.95 * 0.8 * 0.5)] * 10


async def test_session_log_exports_to_a_valid_document(tmp_path):
    session = make_session(tmp_path, mcq_timeout_s=5, special=True)
    session.update_candidates(two_hyps())
    await ask_and_answer(session)
    session.finalize(reason="submit_locations")
    session.log.emit("harness", "run_end", {"turns": session.turns, "cost_usd": session.spend_usd})
    doc = export_panorama(
        session.log.path,
        tmp_path / "pano1.json",
        team=session.settings.team,
        panorama=session.task.model_dump(mode="json"),
        config=session.settings.model_dump(mode="json"),
    )
    assert validate_export(doc) == []
    assert len(doc["final"]["locations"]) == 10
    assert doc["final"]["penalty_state"]["mcqs"] == 1
    assert doc["panorama"]["special"] is True


async def test_subscribers_receive_every_event(tmp_path):
    session = make_session(tmp_path)
    queue = session.subscribe()
    session.update_candidates(two_hyps())
    await asyncio.to_thread(session.submit_cue, VISUAL_CUE, confirmed=True)
    await asyncio.sleep(0.01)
    received = [queue.get_nowait()["type"] for _ in range(queue.qsize())]
    assert received == ["candidates_update", "human_cue"]
    session.unsubscribe(queue)
    session.finalize()
    assert queue.empty()


def test_snapshot_is_json_safe_and_complete(tmp_path):
    session = make_session(tmp_path, special=True)
    session.update_candidates(two_hyps())
    session.record_usage({"input_tokens": 100, "output_tokens": 20, "service_tier": "standard"}, 0.25)
    session.record_usage({"input_tokens": 50, "output_tokens": 5}, 0.10)
    snap = json.loads(json.dumps(session.snapshot()))
    for key in [
        "task", "status", "hypotheses", "provisional", "final", "penalty_state", "pending_mcq",
        "named_places", "elapsed_s", "spend_usd", "turns", "mcq_allowed", "special",
    ]:
        assert key in snap
    assert snap["special"] is True and snap["final"] is None and snap["pending_mcq"] is None
    assert snap["task"]["label"] == "Urban"
    assert len(snap["provisional"]) == 10
    assert snap["turns"] == 2 and snap["spend_usd"] == pytest.approx(0.35)
    assert session.tokens == {"input_tokens": 150, "output_tokens": 25}


def test_started_monotonic_drives_both_clocks(tmp_path):
    session = make_session(tmp_path)
    session.started_monotonic -= 100
    assert session.elapsed_s() >= 100
    assert session.log.emit("harness", "x", {})["t_rel_s"] >= 100


# ---------------------------------------------------------------- tool wrappers


async def test_update_candidates_tool(tmp_path):
    session = make_session(tmp_path)
    args = {"hypotheses": [h.model_dump() for h in two_hyps()]}
    result = await run_update_candidates(ctx(session), args)
    assert not result.is_error and "10 x (38.722252, -9.139337)" in result.content[0]["text"]
    assert len(result.log["entries"]) == 10
    assert len(session.provisional) == 10

    for bad in [
        {"hypotheses": []},
        {"hypotheses": args["hypotheses"] * 6},
        {"hypotheses": [{**args["hypotheses"][0], "lat": 123.0}]},
        {"hypotheses": [{**args["hypotheses"][0], "probability": 70}]},
        {},
    ]:
        result = await run_update_candidates(ctx(session), bad)
        assert result.is_error
    assert points(session.provisional) == {LISBON}


async def test_submit_locations_tool(tmp_path):
    session = make_session(tmp_path)
    bad = await run_submit_locations(ctx(session), {"hypotheses": [], "reasoning_summary": "x"})
    assert bad.is_error and session.final is None
    args = {"hypotheses": [h.model_dump() for h in two_hyps()], "reasoning_summary": "tram 28 and calçada"}
    result = await run_submit_locations(ctx(session), args)
    assert not result.is_error and session.status == "done"
    assert points(session.final) == {LISBON} and all(e.origin == "agent" for e in session.final)
    data = last(session, "final_submission")["data"]
    assert data["reason"] == "submit_locations" and data["reasoning_summary"] == "tram 28 and calçada"

    again = await run_submit_locations(ctx(session), {"hypotheses": [hyp(PORTO, 1.0).model_dump()], "reasoning_summary": ""})
    assert not again.is_error and points(session.final) == {LISBON}
    late = await run_update_candidates(ctx(session), args)
    assert late.is_error
    assert types(session).count("final_submission") == 1


async def test_ask_multiple_choice_tool_answered(tmp_path):
    session = make_session(tmp_path, mcq_timeout_s=5)
    task = asyncio.create_task(
        run_ask_multiple_choice(ctx(session), {"question": "Which?", "options": ["A", "B"], "why_it_matters": "w"})
    )
    await asyncio.sleep(0)
    session.answer_mcq(session.pending_mcq["id"], 1)
    result = await task
    assert not result.is_error and "option 2" in result.content[0]["text"] and "'B'" in result.content[0]["text"]
    assert result.log["selected_index"] == 1
    assert session.ledger.multiplier == pytest.approx(0.95)
