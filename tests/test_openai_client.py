"""Translation between the loop's neutral blocks and Responses API items: no network, no API key."""

from __future__ import annotations

import json
from typing import Any

import pytest
from openai.types.responses import Response

from geoagent.openai_client import flatten_usage, from_response, item_dict, to_input

REASONING = {
    "id": "rs_1",
    "type": "reasoning",
    "summary": [{"type": "summary_text", "text": "**Signs**\n\nPortuguese."}, {"type": "summary_text", "text": "Tram 28."}],
    "encrypted_content": "gAAAA" + "x" * 400,
}
MESSAGE = {
    "id": "msg_1",
    "type": "message",
    "role": "assistant",
    "status": "completed",
    "phase": "commentary",
    "content": [{"type": "output_text", "text": "Checking the tram stop.", "annotations": []}],
}
CALL = {
    "id": "fc_1",
    "type": "function_call",
    "call_id": "call_1",
    "name": "view_crop",
    "arguments": '{"yaw": 90, "pitch": 0}',
    "status": "completed",
}
SEARCH = {
    "id": "ws_1",
    "type": "web_search_call",
    "status": "completed",
    "action": {"type": "search", "query": "Pastelaria Suíça Lisboa", "queries": ["Pastelaria Suíça Lisboa"]},
}
OPEN_PAGE = {
    "id": "ws_2",
    "type": "web_search_call",
    "status": "completed",
    "action": {"type": "open_page", "url": "https://example.org/"},
}
CITATION = {"type": "url_citation", "start_index": 0, "end_index": 5, "title": "Example", "url": "https://example.org/"}
USAGE = {
    "input_tokens": 9000,
    "input_tokens_details": {"cached_tokens": 6000, "cache_write_tokens": 500},
    "output_tokens": 700,
    "output_tokens_details": {"reasoning_tokens": 450},
    "total_tokens": 9700,
}


def response(*output: dict[str, Any], status: str = "completed", **extra: Any) -> Response:
    """A real SDK response object, parsed from the wire shape as the stream's terminal event is."""
    wire = {
        "id": "resp_1", "object": "response", "created_at": 0, "model": "gpt-6.1-sol-2026-09-01", "status": status,
        "output": list(output), "parallel_tool_calls": True, "tool_choice": "auto", "tools": [], "usage": USAGE,
        **extra,
    }  # fmt: skip
    return Response.model_validate(wire)


def image(data: str = "QUJD", media_type: str = "image/jpeg") -> dict[str, Any]:
    return {"type": "image", "source": {"type": "base64", "media_type": media_type, "data": data}}


def text(value: str) -> dict[str, Any]:
    return {"type": "text", "text": value}


# --- from_response ---------------------------------------------------------------------------------


def test_each_output_item_becomes_one_neutral_block_in_order() -> None:
    out = from_response(response(REASONING, MESSAGE, CALL, SEARCH))

    assert out.id == "resp_1" and out.model == "gpt-6.1-sol-2026-09-01"
    thinking, said, call, search = out.content
    assert thinking == {"type": "thinking", "thinking": "**Signs**\n\nPortuguese.\n\nTram 28.", "item": REASONING}
    assert said == {"type": "text", "text": "Checking the tram stop.", "item": MESSAGE}
    assert call == {"type": "tool_use", "id": "call_1", "name": "view_crop", "input": {"yaw": 90, "pitch": 0}, "item": CALL}
    assert search == {
        "type": "server_tool_use",
        "id": "ws_1",
        "name": "web_search",
        "input": SEARCH["action"],
        "item": SEARCH,
    }
    assert out.stop_reason == "tool_use" and out.stop_details is None
    json.dumps(out.content)  # plain data all the way down


def test_items_are_echoable_without_null_fields_or_sdk_extras() -> None:
    """None-valued fields and `parsed_arguments` are 400s when sent back; `summary` (even empty)
    and `encrypted_content` must survive."""
    bare = {"id": "rs_2", "type": "reasoning", "summary": [], "encrypted_content": "gAAAA", "status": None}
    call = {**CALL, "namespace": None, "caller": None, "parsed_arguments": {"yaw": 90}}
    out = from_response(response(bare, call))

    reasoning, tool = (block["item"] for block in out.content)
    assert reasoning == {"id": "rs_2", "type": "reasoning", "summary": [], "encrypted_content": "gAAAA"}
    assert out.content[0]["thinking"] == ""
    assert tool == CALL
    assert item_dict({"type": "function_call", "status": None, "parsed_arguments": {}}) == {"type": "function_call"}
    # an item type the SDK does not model is dumped with plain nested dicts, whose nulls must go too
    unknown = {"type": "brand_new_item", "id": "x_1", "foo": None, "bar": {"baz": None, "q": 1}, "parts": [{"a": None, "b": []}]}
    assert item_dict(unknown) == {"type": "brand_new_item", "id": "x_1", "bar": {"q": 1}, "parts": [{"b": []}]}


def test_message_text_is_concatenated_and_citations_are_kept() -> None:
    parts = [
        {"type": "output_text", "text": "Lisbon", "annotations": [CITATION]},
        {"type": "output_text", "text": ", Baixa.", "annotations": []},
    ]
    cited = from_response(response({**MESSAGE, "content": parts}))
    plain = from_response(response(MESSAGE))

    (block,) = cited.content
    assert block["text"] == "Lisbon, Baixa." and block["annotations"] == [CITATION]
    assert "annotations" not in plain.content[0]
    assert cited.stop_reason == plain.stop_reason == "end_turn"


def test_refusal_part_becomes_a_refusal_block_and_stop_reason() -> None:
    refused = {**MESSAGE, "content": [{"type": "refusal", "refusal": "I can't help with that."}]}
    out = from_response(response(REASONING, refused, CALL))

    assert out.content[1] == {"type": "refusal", "refusal": "I can't help with that.", "item": refused}
    assert out.stop_reason == "refusal"  # even with a function call beside it


@pytest.mark.parametrize(
    ("status", "arguments"),
    [
        ("incomplete", '{"yaw": 9'),  # cut off at the output limit
        ("incomplete", '{"yaw": 90}'),  # marked incomplete: not trusted even when it parses
        ("in_progress", '{"yaw": 90}'),
        ("completed", '{"yaw": '),
        ("completed", "[1, 2]"),  # valid JSON, not an object
        ("completed", ""),
    ],
)
def test_function_call_that_is_not_a_finished_json_object_is_flagged_incomplete(status: str, arguments: str) -> None:
    cut = {**CALL, "status": status, "arguments": arguments}
    (block,) = from_response(response(cut)).content

    assert block == {"type": "tool_use", "id": "call_1", "name": "view_crop", "input": {}, "incomplete": True, "item": cut}


def test_complete_function_call_carries_no_incomplete_flag() -> None:
    (block,) = from_response(response({**CALL, "arguments": "{}"})).content
    assert block["input"] == {} and "incomplete" not in block


def test_unknown_item_types_pass_through_with_their_item() -> None:
    compaction = {"id": "cmp_1", "type": "compaction", "encrypted_content": "gAAAA"}
    (block,) = from_response(response(compaction)).content
    assert block == {"type": "compaction", "item": compaction}


@pytest.mark.parametrize(
    ("status", "details", "output", "expected"),
    [
        ("incomplete", {"reason": "max_output_tokens"}, [REASONING], "max_tokens"),
        ("incomplete", {"reason": "max_output_tokens"}, [CALL], "max_tokens"),  # before tool_use
        ("incomplete", {"reason": "content_filter"}, [MESSAGE], "refusal"),
        ("incomplete", {"reason": "content_filter"}, [CALL], "refusal"),
        ("completed", None, [REASONING, CALL, CALL], "tool_use"),
        ("completed", None, [REASONING, SEARCH, MESSAGE], "end_turn"),  # hosted tools do not continue the turn
        ("completed", None, [], "end_turn"),
    ],
)
def test_stop_reason_is_synthesised(status: str, details: Any, output: list[dict[str, Any]], expected: str) -> None:
    out = from_response(response(*output, status=status, incomplete_details=details))
    assert out.stop_reason == expected and out.stop_details == details


# --- usage -----------------------------------------------------------------------------------------


def test_usage_is_flattened_to_the_six_counters() -> None:
    out = from_response(response(MESSAGE, tool_usage={"web_search": {"num_requests": 3}, "image_gen": {}}))
    assert out.usage == {
        "input_tokens": 9000,
        "cached_input_tokens": 6000,
        "cache_write_tokens": 500,
        "output_tokens": 700,
        "reasoning_tokens": 450,
        "web_search_requests": 3,
    }
    assert all(type(v) is int for v in out.usage.values())


def test_web_searches_are_counted_from_the_items_when_the_api_does_not_report_them() -> None:
    assert flatten_usage(response(SEARCH, OPEN_PAGE, SEARCH, MESSAGE))["web_search_requests"] == 2  # opening a page is free
    # The reported figure wins, zero included.
    assert flatten_usage(response(SEARCH, tool_usage={"web_search": {"num_requests": 0}}))["web_search_requests"] == 0
    assert flatten_usage(response(MESSAGE))["web_search_requests"] == 0


def test_missing_usage_is_all_zeroes() -> None:
    assert set(flatten_usage(response(MESSAGE, usage=None)).values()) == {0}


# --- to_input --------------------------------------------------------------------------------------


def test_user_text_and_images_become_one_message() -> None:
    history = [{"role": "user", "content": [text("Where is this?"), text("yaw 0"), image("QUJD"), text("Go.")]}]

    assert to_input(history, "high") == [
        {
            "role": "user",
            "content": [
                {"type": "input_text", "text": "Where is this?"},
                {"type": "input_text", "text": "yaw 0"},
                {"type": "input_image", "image_url": "data:image/jpeg;base64,QUJD", "detail": "high"},
                {"type": "input_text", "text": "Go."},
            ],
        }
    ]
    assert to_input([{"role": "user", "content": "hi"}]) == [{"role": "user", "content": "hi"}]
    assert to_input([{"role": "user", "content": [image("UE5H", "image/png")]}])[0]["content"] == [
        {"type": "input_image", "image_url": "data:image/png;base64,UE5H", "detail": "original"}
    ]


def test_assistant_blocks_are_echoed_as_the_items_they_came_from() -> None:
    content = from_response(response(REASONING, MESSAGE, SEARCH, CALL)).content
    history = [{"role": "assistant", "content": content}]

    assert to_input(history) == [REASONING, MESSAGE, SEARCH, CALL]


def test_blocks_without_an_item_are_rebuilt() -> None:
    """Hand-built histories: only what has an input form is sent."""
    content = [
        {"type": "thinking", "thinking": "hm"},
        {"type": "text", "text": "Looking east."},
        {"type": "tool_use", "id": "call_9", "name": "view_crop", "input": {"yaw": 90}},
        {"type": "server_tool_use", "id": "ws_9", "name": "web_search", "input": {}},
    ]

    assert to_input([{"role": "assistant", "content": content}]) == [
        {"role": "assistant", "content": [{"type": "output_text", "text": "Looking east."}]},
        {"type": "function_call", "call_id": "call_9", "name": "view_crop", "arguments": '{"yaw": 90}'},
    ]


def test_tool_results_become_function_call_outputs_with_their_images_inside() -> None:
    reply = [
        {"type": "tool_result", "tool_use_id": "call_1", "content": [text("view at yaw 90"), image("QUJD"), text("note")]},
        {"type": "tool_result", "tool_use_id": "call_2", "content": "Not executed.", "is_error": True},
        {"type": "tool_result", "tool_use_id": "call_3", "content": [text("3 places found")]},
    ]

    assert to_input([{"role": "user", "content": reply}], "low") == [
        {
            "type": "function_call_output",
            "call_id": "call_1",
            "output": [
                {"type": "input_text", "text": "view at yaw 90"},
                {"type": "input_image", "image_url": "data:image/jpeg;base64,QUJD", "detail": "low"},
                {"type": "input_text", "text": "note"},
            ],
        },
        {"type": "function_call_output", "call_id": "call_2", "output": "Not executed."},
        {"type": "function_call_output", "call_id": "call_3", "output": [{"type": "input_text", "text": "3 places found"}]},
    ]


def test_notices_follow_the_tool_outputs_as_one_user_message() -> None:
    reply = [
        {"type": "tool_result", "tool_use_id": "call_1", "content": [text("ok")]},
        {"type": "tool_result", "tool_use_id": "call_2", "content": [text("ok")]},
        text("Harness status: turn 3 of 30."),
        text("Operator cue: yellow kerbs."),
    ]

    items = to_input([{"role": "user", "content": reply}])

    assert [item.get("call_id") for item in items] == ["call_1", "call_2", None]
    assert items[2] == {
        "role": "user",
        "content": [
            {"type": "input_text", "text": "Harness status: turn 3 of 30."},
            {"type": "input_text", "text": "Operator cue: yellow kerbs."},
        ],
    }


def test_whole_conversation_keeps_every_call_paired_with_its_output() -> None:
    cut = {**CALL, "id": "fc_2", "call_id": "call_2", "status": "incomplete", "arguments": '{"yaw": 9'}
    turn = from_response(response(REASONING, CALL, cut, status="incomplete", incomplete_details={"reason": "max_output_tokens"}))
    history = [
        {"role": "user", "content": [text("task"), image()]},
        {"role": "assistant", "content": turn.content},
        {
            "role": "user",
            "content": [
                {"type": "tool_result", "tool_use_id": "call_1", "content": [text("crop"), image()]},
                {"type": "tool_result", "tool_use_id": "call_2", "content": "Not executed.", "is_error": True},
                text("Harness status: turn 1 of 30."),
            ],
        },
    ]

    items = to_input(history)

    assert [i.get("type", i.get("role")) for i in items] == [
        "user", "reasoning", "function_call", "function_call", "function_call_output", "function_call_output", "user",
    ]  # fmt: skip
    calls = [i["call_id"] for i in items if i.get("type") == "function_call"]
    outputs = [i["call_id"] for i in items if i.get("type") == "function_call_output"]
    assert calls == outputs == ["call_1", "call_2"]  # the incomplete call is answered too
    assert items[3] == cut
    assert to_input(history) == items  # translating is repeatable: the prefix stays byte-stable


def test_reasoning_left_dangling_by_a_truncated_turn_is_not_sent_back() -> None:
    """A reasoning item needs the item it led to after it; a turn cut off mid-reasoning has none."""
    lone = from_response(response(REASONING, status="incomplete", incomplete_details={"reason": "max_output_tokens"}))
    history = [
        {"role": "user", "content": [text("task")]},
        {"role": "assistant", "content": lone.content},
        {"role": "user", "content": [text("Be brief.")]},
    ]

    assert [i.get("type", i.get("role")) for i in to_input(history)] == ["user", "user"]
    kept = from_response(response(REASONING, MESSAGE, REASONING)).content
    assert to_input([{"role": "assistant", "content": kept}]) == [REASONING, MESSAGE]
