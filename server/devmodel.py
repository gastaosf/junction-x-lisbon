"""A scripted stand-in for the model, for demos and tests (ASTROLABIO_FAKE_MODEL=1).

It walks every panorama through the same short investigation with the real local tools: two
crops and first hypotheses, one more crop, a multiple-choice question when the run allows them,
a refinement, then the submission. It looks at nothing and knows nothing: the places come from a
fixed list, picked by a hash of the panorama id, so a panorama always gets the same answer. Runs
made with it are marked as fake wherever they are shown; they must never be submitted.
"""

from __future__ import annotations

import asyncio
import hashlib
import json
import os
import re
from types import SimpleNamespace
from typing import Any

from astrolabio.openai_client import from_response

DELAY_ENV = "ASTROLABIO_FAKE_MODEL_DELAY_S"
DEFAULT_DELAY_S = 2.0
MODEL_NAME = "fake-demo"
MCQ_AVAILABLE_TEXT = "Multiple-choice questions to the operator are available"

_URBAN_PLACES = (
    ("Alfama, by the tram stop", 38.711840, -9.130260),
    ("Ribeira quay", 41.140650, -8.613050),
    ("Baixa of Coimbra", 40.209420, -8.429480),
    ("Giraldo square", 38.570760, -7.909620),
    ("Old town of Faro", 37.014190, -7.934720),
    ("Cathedral quarter of Braga", 41.549870, -8.427430),
    ("Plaza Mayor of Salamanca", 40.965040, -5.664020),
    ("Triana riverside", 37.385020, -6.002960),
    ("Old quarter of Vigo", 42.238760, -8.726410),
    ("Old town of Caceres", 39.473590, -6.371010),
)
_RURAL_PLACES = (
    ("Serra da Estrela plateau", 40.321800, -7.612500),
    ("Alentejo plain near Beja", 38.045300, -7.861200),
    ("Geres valley", 41.728900, -8.161700),
    ("Douro terraces", 41.160400, -7.556300),
    ("Extremadura dehesa", 39.210500, -6.094800),
    ("Costa Vicentina cliffs", 37.441600, -8.795200),
    ("Sierra de Gredos foothills", 40.251900, -5.262300),
    ("Ribatejo floodplain", 39.201700, -8.629400),
)
_EVIDENCE = (
    "paving pattern and the colour of the kerb stones",
    "tiled facades and the style of the street lamps",
    "roof tiles, white walls and the road markings",
    "vegetation, field boundaries and the shape of the hills",
    "the utility poles and the surface of the track",
)
_PANORAMA_RE = re.compile(r"Panorama (\S+)\.")
_CHOSEN_RE = re.compile(r"The operator chose option (\d)")


def _texts(content: Any) -> list[str]:
    """Every text in a message's content, including what tool results said."""
    if isinstance(content, str):
        return [content]
    found: list[str] = []
    for block in content if isinstance(content, list) else []:
        if not isinstance(block, dict):
            continue
        if isinstance(block.get("text"), str):
            found.append(block["text"])
        found += _texts(block.get("content"))
    return found


class DemoClient:
    """A ModelClient that plays one scripted conversation per panorama. It keeps no state: the
    turn is read from the history it is sent, so a retried request gets the same reply."""

    def __init__(self, delay_s: float | None = None) -> None:
        if delay_s is None:
            try:
                delay_s = float(os.environ.get(DELAY_ENV) or DEFAULT_DELAY_S)
            except ValueError:
                delay_s = DEFAULT_DELAY_S
        self.delay_s = max(0.0, delay_s)

    async def create(self, **params: Any) -> SimpleNamespace:
        messages = list(params.get("messages") or [])
        turn = 1 + sum(1 for message in messages if message.get("role") == "assistant")
        # even a zero delay yields, so six scripted panoramas interleave as real ones would
        await asyncio.sleep(self.delay_s)
        first = " ".join(_texts(messages[0].get("content"))) if messages else ""
        found = _PANORAMA_RE.search(first)
        panorama_id = found.group(1) if found else str(params.get("prompt_cache_key") or "panorama")
        urban = "Label: non-Urban" not in first
        # the latest click, wherever it is in the history: the submission must still honour it
        clicks = _CHOSEN_RE.findall(" ".join(text for m in messages[1:] for text in _texts(m.get("content"))))
        script = _Script(panorama_id, urban, MCQ_AVAILABLE_TEXT in first)
        items = script.turn(turn, int(clicks[-1]) - 1 if clicks else None)
        return from_response(
            {
                "id": f"resp_demo_{script.seed:08x}_{turn}",
                "model": MODEL_NAME,
                "status": "completed",
                "output": items,
                "usage": {
                    "input_tokens": 16000 + 2500 * turn,
                    "input_tokens_details": {"cached_tokens": 14000 + 2000 * (turn - 1) if turn > 1 else 0},
                    "output_tokens": 420 + 30 * (script.seed % 7),
                    "output_tokens_details": {"reasoning_tokens": 180},
                },
            }
        )


class _Script:
    def __init__(self, panorama_id: str, urban: bool, questions: bool) -> None:
        self.panorama_id = panorama_id
        self.urban = urban
        self.questions = questions
        self.seed = int.from_bytes(hashlib.sha256(panorama_id.encode()).digest()[:4], "big")
        places = _URBAN_PLACES if urban else _RURAL_PLACES
        start = self.seed % len(places)
        self.places = [places[(start + step) % len(places)] for step in (0, 3, 5)]

    def _call(self, turn: int, n: int, name: str, args: dict[str, Any]) -> dict[str, Any]:
        call_id = f"call_{self.seed:08x}_{turn}_{n}"
        return {
            "type": "function_call",
            "id": f"fc_{call_id}",
            "call_id": call_id,
            "name": name,
            "arguments": json.dumps(args),
            "status": "completed",
        }

    def _thinking(self, turn: int, text: str) -> dict[str, Any]:
        summary = [{"type": "summary_text", "text": f"[scripted demo, not a real model] {text}"}]
        item_id = f"rs_{self.seed:08x}_{turn}"
        return {"type": "reasoning", "id": item_id, "summary": summary, "encrypted_content": "demo"}

    def _crop(self, turn: int, n: int, step: int, fov: float) -> dict[str, Any]:
        yaw = float((self.seed // 7 + 97 * step) % 360)
        pitch = float((self.seed // 11 + 5 * step) % 21 - 10)
        return self._call(turn, n, "view_crop", {"yaw": yaw, "pitch": pitch, "fov": fov, "enhance": step % 2 == 1})

    def hypotheses(self, weights: tuple[float, ...], favoured: int | None = None) -> list[dict[str, Any]]:
        """The same three places every time, with the weights moved toward `favoured`."""
        order = list(range(len(weights)))
        if favoured is not None and 0 <= favoured < len(order):
            order.remove(favoured)
            order.insert(0, favoured)
        radius = 40.0 if self.urban else 2500.0
        return [
            {
                "lat": self.places[index][1],
                "lng": self.places[index][2],
                "probability": weight,
                "radius_m": radius * (1 + rank),
                "label": self.places[index][0],
                "evidence": "scripted demo: " + _EVIDENCE[(self.seed + index) % len(_EVIDENCE)],
            }
            for rank, (index, weight) in enumerate(zip(order, weights))
        ]

    def turn(self, turn: int, chosen: int | None) -> list[dict[str, Any]]:
        steps = ["survey", "look", *(["ask"] if self.questions else []), "refine"]
        step = steps[turn - 1] if turn <= len(steps) else "submit"
        if step == "survey":
            return [
                self._thinking(turn, "Surveying the views; zooming on the two most detailed directions."),
                self._crop(turn, 1, 0, 40.0),
                self._crop(turn, 2, 1, 25.0),
                self._call(turn, 3, "update_candidates", {"hypotheses": self.hypotheses((0.45, 0.35, 0.2))}),
            ]
        if step == "look":
            return [
                self._thinking(turn, "Three candidate places remain; one more crop to tell them apart."),
                self._crop(turn, 1, 2, 30.0),
            ]
        if step == "ask":
            question = {
                "question": "Which of these places matches what a street-level view of the candidates shows?",
                "options": [f"{name}: matches the panorama" for name, _, _ in self.places],
                "why_it_matters": "The three candidates are far apart; a match settles the answer.",
            }
            return [
                self._thinking(turn, "The candidates are far apart and evenly weighted: worth one question."),
                self._call(turn, 1, "ask_multiple_choice", question),
            ]
        if step == "refine":
            return [
                self._thinking(turn, "Refining the weights with what the last step showed."),
                self._call(turn, 1, "update_candidates", {"hypotheses": self.hypotheses((0.7, 0.2, 0.1), chosen)}),
            ]
        submission = {
            "hypotheses": self.hypotheses((0.8, 0.15, 0.05), chosen),
            "reasoning_summary": "Scripted demo answer: the places come from a fixed list, not from the image.",
        }
        return [self._call(turn, 1, "submit_locations", submission)]
