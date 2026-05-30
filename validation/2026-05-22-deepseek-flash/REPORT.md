# Phase 8 — DeepSeek V4-Flash validation report

**Date:** 2026-05-22
**Branch:** `feat/deepseek-v4-flash`
**Sibling run:** [validation/2026-05-05-multi-provider-corpus/REPORT.md](../2026-05-05-multi-provider-corpus/REPORT.md) — Pro + Gemini baselines on the same 7-source corpus.

## Goal

Validate `deepseek-v4-flash` against the same Phase 7 bar that V4-Pro cleared:

1. 7/7 corpus sources extract `ok=true`.
2. Zero `salvaged truncated response via json-repair` events in nlp-service logs.
3. The 95K-char Open Standards source extracts on first pass within the 600s adapter timeout.

If Flash fails ≥1 source, **still ship** — Flash is opt-in, not the default. Note the failing source here so users know to pick Pro for known-difficult content.

## Results

> _Pending run — populate after `python runner.py` completes._

| Source | chars | entities | concepts | claims | relationships | summary chars | latency |
|---|---:|---:|---:|---:|---:|---:|---:|
| _to fill in_ | | | | | | | |

## Salvage / parse failure check

```
$ docker compose logs nlp-service --since 4h | grep -c "salvaged truncated response via json-repair"
<fill in after run>
```

Phase 7 bar: **0** salvage events.

## Spend

V4-Flash list rates (no current promotion):

- Uncached input: $0.14/M
- Cached input: $0.0028/M
- Output: $0.28/M

| Run | Calls | Input tok | Cache hit tok | Output tok | Cost |
|---|---:|---:|---:|---:|---:|
| _to fill in_ | | | | | |

Expected total at corpus scale: ~$0.01-0.02 (vs $0.10 list for Pro on the same corpus, ~10x cheaper).

## Quality vs Pro

Spot-check 2-3 sources against the [2026-05-05 results.json](../2026-05-05-multi-provider-corpus/results.json) for Pro on the same source — count deltas and a qualitative read of the extracted entities/relationships.

- _to fill in_

## Reproducing

```bash
# 1. Stack up with DEEPSEEK_API_KEY set in .env
docker compose up -d

# 2. Verify health
curl -s :8000/health | python -m json.tool   # expect provider_keys.deepseek: true

# 3. Run corpus
python validation/2026-05-22-deepseek-flash/runner.py

# 4. Verify zero salvage events
docker compose logs nlp-service --since 4h | grep -c "salvaged truncated response via json-repair"
# expect: 0
```

## Files

- `runner.py` — Flash-only corpus walker (600s timeout)
- `results.json` — per-source counts (this run)
- `REPORT.md` — this document
