import re
from dataclasses import dataclass
from pathlib import Path

import pytest

from geoagent import prompts
from geoagent.config import Settings
from geoagent.schema import Label, PanoramaTask
from geoagent.tools.schemas import tool_definitions


@dataclass
class FakeView:
    label: str

    def to_block(self) -> dict:
        return {"type": "image", "source": {"type": "base64", "media_type": "image/jpeg", "data": self.label}}


def _task(label: Label = Label.URBAN, **kwargs) -> PanoramaTask:
    return PanoramaTask(panorama_id="p1", path=Path("p1.jpg"), label=label, **kwargs)


def test_system_prompt_is_byte_stable() -> None:
    first = prompts.build_system_prompt(Settings()).encode()
    second = prompts.build_system_prompt(Settings()).encode()
    assert first == second
    assert prompts.SYSTEM_PROMPT.encode() == first


def test_system_prompt_has_no_timestamps() -> None:
    text = prompts.SYSTEM_PROMPT
    assert not re.search(r"\b20\d\d-\d\d-\d\d\b", text)
    assert not re.search(r"\b\d{1,2}:\d{2}(:\d{2})?\b", text)
    # the only years are the event name and plate-format history, never a run date
    assert set(re.findall(r"\b20\d\d\b", text)) == {"2026", "2020", "2000"}


def test_system_prompt_ignores_settings_that_must_not_bust_the_cache() -> None:
    base = prompts.build_system_prompt(Settings())
    varied = Settings(hedge=True, team="other", runs_dir=Path("elsewhere"), mcq_allowed=False, concurrency=2)
    assert prompts.build_system_prompt(varied) == base


def test_system_prompt_covers_the_spec() -> None:
    text = prompts.SYSTEM_PROMPT
    for needle in [
        "JunctionX Lisbon 2026",
        "Albatroz",
        "organiser-supplied",
        "2 / (1 + d / 100 m)",
        "2 / (1 + d / 10 km)",
        "x0.95",
        "x0.8",
        "x0.5",
        "midpoint",
        "where the camera stood",
        "confident wrong answer",
        "Street names are seldom readable",
        "Honest probabilities",
        "before you submit or not at all",
        "about 2 km",
        "(low confidence)",
    ]:
        assert needle in text, needle
    steps = ["Survey.", "Hypothesise.", "Read text.", "Orient.", "Generate candidates.", "Verify.",
             "Decide about a question.", "Submit."]
    positions = [text.index(f"{n}. {step}") for n, step in enumerate(steps, start=1)]
    assert positions == sorted(positions)


def test_playbook_covers_every_region_and_topic() -> None:
    playbook = prompts.REGIONAL_PLAYBOOK
    assert playbook in prompts.SYSTEM_PROMPT
    for region in ["Portugal", "Spain", "France", "Azores", "Madeira", "Canar", "Balearic", "Corsica"]:
        assert region in playbook, region
    for topic in ["Postcodes", "Phones", "Roads", "Plates", "bollards", "poles", "Brands", "Architecture",
                  "Vegetation", "Coasts", "Edge lines", "vocabulary"]:
        assert topic in playbook, topic


def test_playbook_carries_the_unverified_draft_warning_in_source() -> None:
    source = Path(prompts.__file__).read_text(encoding="utf-8")
    comment = source[: source.index("REGIONAL_PLAYBOOK = ")].rsplit("\n\n", 1)[-1]
    assert "drafted from memory" in comment
    for reference in ["Plonk It", "geotips.net", "geometas"]:
        assert reference in comment


def test_every_tool_is_mentioned_when_web_is_allowed() -> None:
    settings = Settings()
    text = prompts.build_system_prompt(settings)
    for tool in tool_definitions(settings):
        name = tool.get("name") or tool["type"]  # hosted tools are named by their type
        assert name in text, name


def test_offline_prompt_drops_external_tools() -> None:
    text = prompts.build_system_prompt(Settings(allow_web=False))
    assert "switched off for this run" in text
    assert "- search_places geocodes" not in text
    assert "- streetview_lookup returns" not in text
    assert "view_crop" in text and "sun_position" in text


def test_no_human_prompt_disables_questions() -> None:
    text = prompts.build_system_prompt(Settings(no_human=True))
    assert "fully autonomous" in text
    assert "x0.857" not in text
    assert "at most 2 questions" in prompts.build_system_prompt(Settings(max_mcq=2))


def test_prompt_does_not_shout() -> None:
    shouted = re.findall(r"\b(?:MUST|NEVER|ALWAYS|CRITICAL|IMPORTANT|DO NOT)\b", prompts.SYSTEM_PROMPT)
    assert shouted == []
    assert "{" not in prompts.SYSTEM_PROMPT and "}" not in prompts.SYSTEM_PROMPT


def test_initial_user_content_labels_every_image() -> None:
    views = [FakeView("Overview (equirectangular, yaw ruler on top)"), FakeView("View yaw 0, pitch 0, fov 90")]
    content = prompts.initial_user_content(_task(timestamp="20261011093000"), views)
    assert [block["type"] for block in content] == ["text", "text", "image", "text", "image", "text"]
    assert content[1]["text"] == views[0].label and content[2] == views[0].to_block()
    assert content[3]["text"] == views[1].label and content[4] == views[1].to_block()
    head = content[0]["text"]
    assert "Label: Urban" in head and "d / 100 m" in head
    assert "2026-10-11 09:30:00" in head and "20261011093000" in head and "UTC or local" in head
    assert "Special One" not in head and "Multiple-choice" not in head
    assert "update_candidates" in content[-1]["text"]


def test_initial_user_content_variants() -> None:
    task = _task(Label.NON_URBAN, special=True)
    head = prompts.initial_user_content(task, [], mcq_available=True)[0]["text"]
    assert "Label: non-Urban" in head and "d / 10 km" in head
    assert "Special One" in head and "counts triple" in head
    assert "Capture timestamp: not provided" in head
    assert "questions to the operator are available" in head
    off = prompts.initial_user_content(task, [], mcq_available=False)[0]["text"]
    assert "not available" in off


@pytest.mark.parametrize("raw", ["2026-10-11", "garbage"])
def test_malformed_timestamp_is_passed_through(raw: str) -> None:
    assert prompts.format_timestamp(raw) == f"{raw} (unrecognised format)"


def test_initial_user_content_is_deterministic() -> None:
    views = [FakeView("a"), FakeView("b")]
    task = _task(timestamp="20261011093000")
    assert prompts.initial_user_content(task, views) == prompts.initial_user_content(task, views)


def test_notices() -> None:
    assert "submit_locations" in prompts.COMMIT_NOW_NOTICE
    assert "submit_locations" in prompts.FINAL_REMINDER
    assert "submit_locations" in prompts.NO_SUBMISSION_NUDGE
    assert prompts.MAX_TOKENS_NOTICE
    message = prompts.cue_message("  look at the blue tiled building  ")
    assert message.endswith("look at the blue tiled building")
    assert "x0.8" in message
