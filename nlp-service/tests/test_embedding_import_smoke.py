"""Smoke test: real sentence-transformers import stack (not conftest-stubbed).

conftest.py stubs sentence_transformers for speed, so a fresh ``pip install``
can pull transformers 5.x incompatible with the Dockerfile's torch==2.5.1 pin
without any unit test failing. This runs the import in a subprocess so the
stub never applies.

Regression: resolve 500 ``embedding_failed`` when transformers 5.10+ met
torch 2.5.1 after a Docker requirements-layer cache bust (2026-06-06).
"""

from __future__ import annotations

import subprocess
import sys


def test_sentence_transformer_imports_with_pinned_torch() -> None:
    script = (
        "import transformers; "
        "from sentence_transformers import SentenceTransformer; "
        "assert transformers.__version__.startswith('4.'), transformers.__version__; "
        "print('ok')"
    )
    result = subprocess.run(
        [sys.executable, "-c", script],
        capture_output=True,
        text=True,
        timeout=120,
    )
    assert result.returncode == 0, (
        "sentence-transformers import failed — likely torch/transformers pin drift\n"
        f"stdout: {result.stdout}\nstderr: {result.stderr}"
    )
    assert "ok" in result.stdout
