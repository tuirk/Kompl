"""Compile-model allowlist at the FastAPI boundary.

Every request model that carries ``compile_model`` validates against
``LLMModel``. Mirror of ``LLM_MODELS`` in app/src/lib/llm-models.ts;
app/src/__tests__/llm-models.test.ts fails if the two lists differ, so the
Settings dropdown can never offer a model this service rejects with a 422.

Never delete an ID: stored settings, per-session locks
(compile_progress.compile_model) and old backups reference them. A retired
model stays here and moves to the app's legacy group instead. Adding a model
also needs a price in that provider's ``_MODEL_PRICES``.
"""

from __future__ import annotations

from typing import Literal

LLMModel = Literal[
    "deepseek-flash",
    "deepseek-v4-pro",
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-pro-preview",
    # Legacy: kept so existing settings, session locks and backups stay valid.
    "gemini-2.5-flash",
    "gemini-2.5-flash-lite",
    "gemini-2.5-pro",
    "deepseek-v4-flash",
]
