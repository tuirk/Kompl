"""Kompl v2 nlp-service FastAPI app.

Commit 3 scope: conversion only. This service exposes two endpoints
(`POST /convert/url` and `POST /convert/file-path`) plus `GET /health`.

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

from fastapi import FastAPI
from pydantic import BaseModel, ConfigDict

from routers.conversion import router as conversion_router


class HealthResponse(BaseModel):
    model_config = ConfigDict(extra='forbid')

    status: str


app = FastAPI(title="kompl-nlp-service", version="0.3.0")

app.include_router(conversion_router)


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(status="ok")
