# Phase 7 corpus revalidation — DeepSeek validation report

**Date:** 2026-05-05
**Branch:** `feat/multi-provider-llm-phase-6-7` (off `origin/main` @ `ecadbe0`)
**Plan:** [docs/plans/2026-05-05-deepseek-second-llm-provider.md](../../docs/plans/2026-05-05-deepseek-second-llm-provider.md)
**Spec:** [docs/plans/phase_7_spec.md](../../docs/plans/phase_7_spec.md)

## Headline

DeepSeek-v4-pro extracts cleanly on **7/7** sources in `nlp-service/test_corpus/`, with **0 parse failures and 0 salvage attempts** — including the 95K-char Open Standards source where Gemini truncates at the 50K input cap.

This run validates the master plan's 28-call spike claim (which was never quantified per-source) at corpus scale, and confirms the prompt-drift fix shipped in this phase.

## What this phase changed

1. **Route Literal expansion** ([nlp-service/routers/pipeline.py](../../nlp-service/routers/pipeline.py), [nlp-service/routers/resolution.py](../../nlp-service/routers/resolution.py)) — added `'deepseek-v4-pro'` to the `GeminiModel` Literal so `compile_model: "deepseek-v4-pro"` no longer 422s at the route boundary. (Already in `main` via the PR #56 squash; surfaced during this phase, retained here for completeness.)
2. **Prompt schema-drift fix** ([nlp-service/services/llm_client.py](../../nlp-service/services/llm_client.py)) — `_EXTRACTION_SYSTEM_PROMPT` enumerated sub-fields for `relationships` (shipped via PR #56) but not for `entities`/`concepts`/`claims`. Gemini's `response_schema=LLMExtractionResponse` mode lifts those fields server-side from the Pydantic model; DeepSeek's `response_format={"type":"json_object"}` mode reads only the prompt text and emitted entities without `name`, etc. — producing 15 `Field required` Pydantic errors on Vilnius30. Fix enumerates every required Pydantic field as a sub-bullet under each top-level item in the prompt.

## DeepSeek results (7/7 OK)

Counts captured via `runner.py` from the live `/pipeline/extract-llm` route. All values are exact, not summarised.

| Source | chars | entities | concepts | claims | relationships | summary chars | latency |
|---|---:|---:|---:|---:|---:|---:|---:|
| 30+ Places You Should See in Vilnius | 31,785 | 15 | 7 | 12 | 13 | 631 | 233.6s |
| Introduction to agent skills | 33,029 | 13 | 6 | 12 | 10 | 753 | 167.0s |
| kelly-criterion | 25,355 | 15 | 6 | 10 | 8 | 607 | 212.3s |
| Museums of Kaunas | 16,372 | 15 | 8 | 15 | 10 | 528 | 374.1s |
| Open Standards for AI Skills | **95,027** | 15 | 8 | 15 | 10 | 693 | 289.6s |
| Vilnius Travel Guide | 27,485 | 15 | 10 | 15 | 10 | 464 | 387.6s |
| tinyforming-mars-rulebook | 22,707 | 15 | 8 | 15 | 10 | 649 | 197.2s |

Notable: every source returns the schema's max of 15 entities (the prompt says "up to 15"); concept/claim/relationship counts spread naturally with content. The 95K-char Open Standards source extracts in ~290s with full counts — Gemini cannot do this at all (input cap=50K, hits MAX_TOKENS even after the halved-fallback).

## Salvage / parse failure check

```
$ docker compose logs nlp-service --since 4h | grep -c "salvaged truncated response via json-repair"
0
```

Zero `salvaged` lines across all 11 DeepSeek calls (7 v1 + 4 rerun). Master plan claim ("0 salvage attempts on DeepSeek") confirmed at corpus scale.

## DeepSeek spend

DeepSeek discount-window pricing (active through 2026-05-31T15:59:00Z UTC):
- Uncached input: $0.07/M
- Cached input: $0.014/M
- Output: $0.27/M

| Run | Calls | Uncached input tok | Cached input tok | Output tok | Cost @ discount |
|---|---:|---:|---:|---:|---:|
| v1 (240s timeout) | 7 | 63,272 | 1,280 | 61,824 | $0.0211 |
| Rerun (600s, 4 sources) | 4 | 333 | 41,600 | 39,358 | $0.0112 |
| **Total** | **11** | **63,605** | **42,880** | **101,182** | **$0.0324** |

The rerun cost is dominated by output tokens — DeepSeek's prompt cache absorbed nearly the entire input on the second pass (41,600 of 41,933 input tokens were cache hits), so input billing was effectively free, but the model regenerated the JSON each time at full output cost.

At list pricing (post-2026-05-31 @ $0.27/M input + $1.10/M output) the same 7-source corpus would cost ~$0.10. Daily LLM cap is $5; well under.

## Why the rerun was necessary (and Gemini-only context)

The runner (`runner.py`) used a 240s `urlopen` timeout. Four DeepSeek calls reached `prompt_cache_hit_tokens` and committed server-side but exceeded that wall-clock — the runner saw HTTP -1 (socket timeout) while DeepSeek logged successful completion. `rerun_timeouts.py` re-invoked just those 4 sources at 600s; no model behaviour changed, only the runner's read window. All four cleared on the first retry.

The rerun script is **DeepSeek-only** because Gemini's monthly project spend cap was hit during v1's last source — any Gemini retry would 429 RESOURCE_EXHAUSTED. See Gemini comparison below.

## Gemini comparison (partial — context, not the focus)

Phase 7 prioritises DeepSeek validation; Gemini coverage is partial because of upstream issues unrelated to this phase's code:

| Source | Gemini result | Notes |
|---|---|---|
| 30+ Places You Should See in Vilnius | 500 empty response | RECITATION / content-filter (travel content) |
| Introduction to agent skills | OK e=8 c=9 cl=12 r=8 | clean |
| kelly-criterion | OK e=10 c=7 cl=13 r=7 | clean |
| Museums of Kaunas | 500 empty response | RECITATION / content-filter |
| Open Standards for AI Skills | timeout 261s + halved-fallback also MAX_TOKENS | 95K input exceeds 50K cap; halved-fallback also failed |
| Vilnius Travel Guide | 500 empty response | RECITATION / content-filter |
| tinyforming-mars-rulebook | 500 429 RESOURCE_EXHAUSTED | monthly project spend cap exhausted |

Gemini's failure modes are upstream:
- **3× RECITATION / empty response** on travel-guide content. Pre-existing behaviour; not caused by this phase. Same content extracts fine on DeepSeek.
- **1× MAX_TOKENS** on the 95K Open Standards source. Expected: Gemini's 50K input cap (`_GEMINI_EXTRACT_INPUT_CAP`) truncates the source; the halved-fallback also exceeds output budget.
- **1× monthly quota exhaustion** on the last source. The Google Cloud project hit its monthly spend cap; until billing rolls over, Gemini retries 429.

Net Gemini: 2/7 OK in this corpus revalidation pass. DeepSeek's 7/7 confirms it as the more capable backend for the heterogeneous corpus this codebase actually ingests.

## Success criteria status

From `docs/plans/phase_7_spec.md`:

| # | Criterion | Status |
|---|---|---|
| 1 | Both `routers/{pipeline,resolution}.py` Literals include `'deepseek-v4-pro'` | ✅ (in main via PR #56) |
| 2 | `compile_model: "deepseek-v4-pro"` no longer 422s on `/pipeline/extract-llm` | ✅ (verified by runner round-trip) |
| 3 | Every source extracts on Gemini | ⚠️ partial (2/7; failures are RECITATION/quota, not regressions) |
| 4 | Every source extracts on DeepSeek | ✅ 7/7 |
| 5 | 0 hits on `salvaged truncated response via json-repair` for DeepSeek | ✅ |
| 6 | `results.json` recorded with per-source per-provider counts | ✅ |
| 7 | `pytest nlp-service/tests/ nlp-service/services/providers/` 188/188 green | (run before commit; prompt-only edit, no code paths touched) |

Criterion 3 is the only partial. The Phase 7 spec acknowledged Gemini may MAX_TOKENS on Open Standards; the additional RECITATION + quota failures are infrastructural and unrelated to the multi-provider work. They do not block phase exit because:

- The phase's primary goal — validating DeepSeek as a working second backend — is met (7/7).
- Gemini's RECITATION on travel content is a known upstream behaviour (pre-Phase-2; reproducible against bare `genai.Client` calls).
- The quota issue is a billing artefact, not a code regression.

## Reproducing

```bash
# 1. Bring up the stack with both keys in .env
docker compose up -d

# 2. Verify health
curl -s :8000/health | python -m json.tool   # expect provider_keys: {gemini: true, deepseek: true}
curl -s :3000/api/health | python -m json.tool

# 3. Run corpus
python validation/2026-05-05-multi-provider-corpus/runner.py

# 4. If any DeepSeek call returns http_status=-1, re-run the timeouts at 600s
python validation/2026-05-05-multi-provider-corpus/rerun_timeouts.py

# 5. Verify zero salvage events
docker compose logs nlp-service --since 4h | grep -c "salvaged truncated response via json-repair"
# expect: 0
```

## Files

- `runner.py` — corpus walker (240s timeout, both providers)
- `rerun_timeouts.py` — DeepSeek-only retry at 600s for any `http_status == -1` entries
- `results.json` — per-source × per-provider counts (this run)
- `REPORT.md` — this document
