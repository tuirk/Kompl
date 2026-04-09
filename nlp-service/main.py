"""Kompl v2 nlp-service FastAPI app.

Commit 4 scope: conversion + LLM compile pipeline.
  - POST /convert/url           — Firecrawl v2 scrape → markdown
  - POST /convert/file-path     — MarkItDown local-file → markdown
  - POST /pipeline/compile-simple — Gemini structured output → wiki page fields
  - GET  /health

Future commits will add routers for:
  - extraction  (commit 10 — spaCy NER, RAKE, YAKE, KeyBERT, TextRank, TopicRank)
  - embedding   (commit 6  — sentence-transformers)
  - vectors     (commit 6  — Chroma search/upsert/delete)
  - pipeline    (commit 10 — /pipeline/extract, /pipeline/resolve, /pipeline/draft)
  - wiki        (commit 12 — wiki rebuild orchestration)

Intentionally minimal: no middleware, no CORS, no logging config. This
service runs on the internal Docker network only (n8n-sidecar pattern per
CLAUDE.md rule #3) so there is no browser-origin concern and no need for
request logging beyond what uvicorn emits by default.

This service NEVER opens the SQLite database. rule #1 in CLAUDE.md: the
only process that holds a kompl.db file descriptor is Next.js (plus the
migration script, briefly, at boot).
"""

import logging
import os

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict

from routers.conversion import router as conversion_router
from routers.pipeline import router as pipeline_router
from routers.storage import router as storage_router

logger = logging.getLogger(__name__)


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    status: str


app = FastAPI(title="kompl-nlp-service", version="0.4.0")

app.include_router(conversion_router)
app.include_router(pipeline_router)
app.include_router(storage_router)


@app.on_event("startup")
def startup_check() -> None:
    """Validate required environment variables at startup.

    Fails loudly if GEMINI_API_KEY is not set — better to crash at startup
    than to get a 500 on the first compile request 30 seconds later.
    """
    gemini_key = os.environ.get("GEMINI_API_KEY", "")
    if not gemini_key:
        logger.warning(
            "GEMINI_API_KEY is not set. "
            "POST /pipeline/compile-simple will fail with 500. "
            "Set GEMINI_API_KEY in docker-compose.yml / .env."
        )


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok")
