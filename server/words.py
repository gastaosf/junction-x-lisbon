"""Small words for sentences an operator reads: a count with its noun in the right number."""

from __future__ import annotations

from collections.abc import Sequence

_IRREGULAR = {"entry": "entries", "hypothesis": "hypotheses", "is": "are", "was": "were", "has": "have"}


def plural(n: int | float, word: str, many: str | None = None) -> str:
    """`word` as it reads after the number `n`: plural(2, "panorama") is "panoramas"."""
    if n == 1:
        return word
    if many is not None:
        return many
    head, _, last = word.rpartition(" ")
    regular = last[:-1] + "ies" if last.endswith("y") and last[-2:-1] not in "aeiou" else last + "s"
    last = _IRREGULAR.get(last, regular)
    return f"{head} {last}" if head else last


def count(n: int | float, word: str, many: str | None = None) -> str:
    """"1 panorama", "3 panoramas", "0 panoramas"."""
    return f"{n} {plural(n, word, many)}"


def listed(names: Sequence[object], last: str = "and") -> str:
    """"a", "a and b", "a, b and c"."""
    words = [str(name) for name in names]
    if len(words) <= 1:
        return "".join(words)
    return f"{', '.join(words[:-1])} {last} {words[-1]}"
