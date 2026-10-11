"""Front-end checks that need Node.js: syntax of every console module and the pure-logic tests.

The console has no build step, so a syntax error in one ES module would only show up in the
browser as a screen that fails to load. Skipped when `node` is not installed.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[1]
JS_DIR = ROOT / "server" / "static" / "console" / "js"
JS_TESTS = ROOT / "tests" / "js"
NODE = shutil.which("node")

pytestmark = pytest.mark.skipif(NODE is None, reason="node is not installed")


def _run(args: list[str]) -> subprocess.CompletedProcess[str]:
    return subprocess.run([NODE, *args], cwd=ROOT, capture_output=True, text=True, timeout=300)


def test_every_console_module_parses() -> None:
    files = sorted(JS_DIR.rglob("*.js"))
    assert files, f"no JavaScript found under {JS_DIR}"
    failures = []
    for path in files:
        result = _run(["--check", str(path)])
        if result.returncode != 0:
            failures.append(f"{path.relative_to(ROOT)}\n{result.stderr.strip()}")
    assert not failures, "syntax errors:\n\n" + "\n\n".join(failures)


def test_pure_logic_node_tests_pass() -> None:
    # The files are listed explicitly: `node --test <directory>` only works on some Node versions.
    files = sorted(JS_TESTS.glob("*.test.mjs"))
    assert files, f"no node tests found under {JS_TESTS}"
    result = _run(["--test", *[str(path) for path in files]])
    assert result.returncode == 0, result.stdout[-6000:] + "\n" + result.stderr[-2000:]
