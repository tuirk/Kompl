# Phase 7 Spec — corpus revalidation + route-Literal gap fix

**Plan:** [docs/plans/2026-05-05-deepseek-second-llm-provider.md](2026-05-05-deepseek-second-llm-provider.md)
**Branch:** `feat/multi-provider-llm`
**Status:** Active.
**Depends on:** Phase 6 (commit `e70d0b7` — Settings UI dropdown gating live; 188/188 nlp + 373/373 app tests green).

## Scope

Run the preserved [nlp-service/test_corpus/](../../nlp-service/test_corpus/) (6 manifested + 1 extra source) through both providers via the new dispatched code path and verify the results match the master plan's spike claims:
- DeepSeek extracts cleanly (0 parse failures, 0 salvage attempts) on every source, **including** the 95K-char Open Standards source where Gemini truncates at the 50K input cap.
- Gemini still extracts cleanly on the smaller sources (no regression vs. pre-Phase-2 behaviour).
- Per-source entity / concept / claim counts are recorded as the new baseline (the master plan's "±10% of spike baseline" tolerance can't be applied rigorously — the 28-call spike's per-source numeric counts were not captured at the time; we record fresh numbers here as the new reference).

While running corpus revalidation, fix a Phase 4 gap that surfaced: the FastAPI request `Literal` types in [nlp-service/routers/pipeline.py](../../nlp-service/routers/pipeline.py) and [nlp-service/routers/resolution.py](../../nlp-service/routers/resolution.py) restrict `compile_model` to the three Gemini SKUs, so the new `deepseek-v4-pro` model string would 422 at the route boundary even though Phase 6's Settings UI can save it. Each Literal needs to gain `'deepseek-v4-pro'`.

**In scope:**
- `nlp-service/routers/pipeline.py` — expand the `GeminiModel` Literal at [:51-55](../../nlp-service/routers/pipeline.py#L51) to include `'deepseek-v4-pro'`. The 7 usage sites at [:62, :73, :156, :207, :241, :261, :329](../../nlp-service/routers/pipeline.py) pick the new string up automatically.
- `nlp-service/routers/resolution.py` — same change at [:30-34](../../nlp-service/routers/resolution.py#L30).
- New `validation/2026-05-05-multi-provider-corpus/` dir with:
  - `runner.py` — Python script that walks `test_corpus/`, posts each source to `/pipeline/extract-llm` with both provider models, captures entity/concept/claim/relationship counts + finish_reason + parse status
  - `results.json` — recorded per-source × per-provider numbers

**Out of scope:**
- Renaming `GeminiModel` to `LLMModel` everywhere (just adding the literal string is a one-line behaviour-preserving change; renaming touches the 9 declaration sites).
- Adding new unit tests for the route Literal change (the runner script is the integration-level proof).
- Running the full compile pipeline (extract → resolve → plan → draft → crossref → commit → schema) on each source — extract is the central call site that the master plan flagged for revalidation; the other steps are covered by the unit suite.
- Live n8n-driven flow (stage 14+ orchestration) — that has a pre-existing failure mode unrelated to provider work.
- Investigating the "kelly-criterion.md" 7th source which isn't in the manifest. Run it anyway for completeness.

## Data contracts

### Route Literal expansion

Both files gain one new entry:

```python
GeminiModel = Literal[
    "gemini-2.5-flash-lite",
    "gemini-2.5-flash",
    "gemini-2.5-pro",
    "deepseek-v4-pro",
]
```

The variable name stays `GeminiModel` for now — renaming requires touching 9 declaration sites and breaks no existing import. A future cleanup can rename to `LLMModel`; out of scope.

### `validation/2026-05-05-multi-provider-corpus/results.json` schema

```json
{
  "run_at": "ISO8601 UTC instant",
  "branch": "feat/multi-provider-llm",
  "head_commit": "<sha>",
  "providers": ["gemini-2.5-flash", "deepseek-v4-pro"],
  "sources": [
    {
      "name": "30+ Places You Should See in Vilnius - Curl Abroad.md",
      "markdown_chars": 31785,
      "results": {
        "gemini-2.5-flash": {
          "ok": true,
          "entity_count": 18,
          "concept_count": 6,
          "claim_count": 12,
          "relationship_count": 4,
          "salvage_used": false
        },
        "deepseek-v4-pro": {
          "ok": true,
          ...
        }
      }
    },
    ...
  ]
}
```

The runner doesn't probe nlp-service stderr to detect "salvage_used"; it infers from the response shape (the salvage path produces a structurally-different LLMExtractionResponse with the json-repair concession that we can't easily detect from outside). Treat `salvage_used` as `null` (unknown) for now; the master plan claim "0 salvage attempts on DeepSeek" is verified by tailing nlp-service logs for `salvaged truncated response via json-repair` lines during the run.

## Public API / tool / config changes

Route validation now accepts `'deepseek-v4-pro'` for `compile_model` on every nlp-service `/pipeline/*` and `/resolve/*` endpoint. No new endpoints. No DB schema. No env vars.

## Success criteria

1. Both `routers/pipeline.py:GeminiModel` and `routers/resolution.py:GeminiModel` Literal types include `'deepseek-v4-pro'`.
2. Sending `compile_model: "deepseek-v4-pro"` to `/pipeline/extract-llm` no longer returns 422.
3. Every source in `test_corpus/` extracts successfully on Gemini (with the existing 50K cap; Open Standards may MAX_TOKENS).
4. Every source in `test_corpus/` extracts successfully on DeepSeek (with the 200K cap added in Phase 3.2; Open Standards extracts clean).
5. nlp-service log search for `salvaged truncated response via json-repair` returns 0 hits across the DeepSeek run (matches master plan claim).
6. `results.json` recorded with per-source per-provider counts.
7. `pytest nlp-service/tests/ nlp-service/services/providers/` — still 188/188 green (the route Literal change is additive and backward-compatible).

## Out-of-scope items

(See Scope.) `LLMModel` rename, full pipeline run, n8n orchestration debug — separate.

## Safety constraints

- **Cost ceiling.** Daily LLM cap is $5 by default. 7 sources × 2 providers = 14 LLM calls. Gemini Flash on the largest source (~95K input) is ~$0.10; DeepSeek on the same is ~$0.02 (discount-window pricing). Total expected spend ~$0.50. Well under the cap.
- **The runner posts to `/pipeline/extract-llm` only.** No multi-step pipeline calls; no commit to the wiki database; no side effects on Pages.
- **DeepSeek live API.** First Phase-7 invocation is the first live call against DeepSeek's API in this branch's history. Phase 4 covered it with mocked HTTP only.
- **Output dir is gitignored.** `validation/` per CLAUDE.md preference; the recorded `results.json` is committed to this branch only as a phase-exit artifact (this PR description references it but the dir contents stay branch-local).

## Test strategy

### Pre-implementation
- 188 + 373 tests green; Phase 6 commit `e70d0b7` is HEAD.

### Per-task
- **7.1 Route Literal expansion:** verify by `curl -X POST /pipeline/extract-llm` with `compile_model: "deepseek-v4-pro"` against a small payload — expect 200 (or upstream LLM error, not 422).
- **7.2 Runner script:** start with a single source × single provider to confirm the runner skeleton works, then expand.
- **7.3 Full corpus run:** record results, tail nlp-service logs for salvage events.

### Phase exit
- `results.json` written.
- Salvage-line grep: 0 hits on DeepSeek.
- Markdown summary in PR description.

## Decomposition

**Task 7.1** — Route Literal expansion. Two files; mechanical.
**Task 7.2** — Runner script + initial smoke (one source × Gemini).
**Task 7.3** — Full corpus × both providers; results.json.

Bundle as one commit. The route Literal change is small enough that splitting commits adds no review value.

## References

- Master plan: [2026-05-05-deepseek-second-llm-provider.md](2026-05-05-deepseek-second-llm-provider.md) (Phase 7)
- Phase 6 commit: `e70d0b7`
- Phase 6 spec: [phase_6_spec.md](phase_6_spec.md)
- Test corpus: [nlp-service/test_corpus/](../../nlp-service/test_corpus/) (6 manifested + 1 extra)
- 28-call spike claim: master plan Context table — "28/28 ok, 0 parse failures, 0 salvage attempts needed, including the 95K-char Open Standards source"
- DeepSeek input-char cap (200K): added in Phase 3.2 commit `52fd8de`
- Gemini extract input-char cap (50K): pre-existing constant `_GEMINI_EXTRACT_INPUT_CAP`
