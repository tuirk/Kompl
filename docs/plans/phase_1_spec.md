# Phase 1 Spec — Append `"json"` trailer to 7 system prompts

**Plan:** [docs/plans/2026-05-05-deepseek-second-llm-provider.md](2026-05-05-deepseek-second-llm-provider.md)
**Branch:** `feat/multi-provider-llm`
**Status:** Active.

## Scope

Append a single shared trailer string `_JSON_TRAILER` to each of the 7 LLM-facing system prompts in [nlp-service/services/llm_client.py](../../nlp-service/services/llm_client.py). No other edits.

**In scope:**
- `_LINT_SYSTEM_PROMPT` ([nlp-service/services/llm_client.py:490](../../nlp-service/services/llm_client.py#L490))
- `_EXTRACTION_SYSTEM_PROMPT` ([nlp-service/services/llm_client.py:634](../../nlp-service/services/llm_client.py#L634))
- `_DISAMBIGUATION_SYSTEM_PROMPT` ([nlp-service/services/llm_client.py:864](../../nlp-service/services/llm_client.py#L864))
- `_DISAMBIGUATION_CONCEPT_SYSTEM_PROMPT` ([nlp-service/services/llm_client.py:882](../../nlp-service/services/llm_client.py#L882))
- `_CROSSREF_SYSTEM_PROMPT` ([nlp-service/services/llm_client.py:1269](../../nlp-service/services/llm_client.py#L1269))
- `_SELECT_PAGES_SYSTEM_PROMPT` ([nlp-service/services/llm_client.py:1519](../../nlp-service/services/llm_client.py#L1519))
- `_SYNTHESIZE_SYSTEM_PROMPT` ([nlp-service/services/llm_client.py:1616](../../nlp-service/services/llm_client.py#L1616))

**Out of scope:**
- Any other prompt edit (no rephrasing, no trimming, no schema-hint changes beyond the trailer)
- Provider abstraction work (Phase 2)
- `messages=[system, user]` shape conversion (Phase 3)
- Any DeepSeek wiring (Phase 4+)

## Data contracts

The trailer is a module-level constant placed immediately below `_DEFAULT_MODEL` ([nlp-service/services/llm_client.py:121](../../nlp-service/services/llm_client.py#L121)):

```python
_JSON_TRAILER = (
    "\n\nReturn the response as a single json object matching the schema "
    "described above. Do not include any text outside the json."
)
```

Each of the 7 prompt constants is suffixed via string concatenation at the constant-declaration site:

```python
_LINT_SYSTEM_PROMPT = """\
…existing body…
""" + _JSON_TRAILER
```

The leading `\n\n` in `_JSON_TRAILER` guarantees a paragraph break regardless of whether the existing prompt body ends in `\n`.

## Public API / tool / config changes

None. No FastAPI route surfaces, no Pydantic models, no env vars, no DB schema, no settings keys, no docker-compose changes, no n8n workflow JSON. Internal-only string-content edit.

## Success criteria

1. `_JSON_TRAILER` exists exactly once as a module-level constant
2. All 7 listed prompts end with the trailer (verifiable by `endswith` check)
3. The literal word `"json"` appears at least once in each prompt body (DeepSeek json_object mode requirement, Quirk #1 in master plan)
4. Existing tests in `nlp-service/tests/test_llm_client.py` covering lint/extract/disambiguate/crossref/select_pages/synthesize stay green
5. `bash scripts/integration-test.sh --stage 4` passes against a known-good source from `nlp-service/test_corpus/`
6. `gitnexus_detect_changes` shows only `nlp-service/services/llm_client.py` modified

## Out-of-scope items

(See Scope above.) Anything beyond the literal trailer append is a separate phase.

## Safety constraints

- **No behaviour change for Gemini.** Gemini ignores the additional natural-language instruction — the trailer is a no-op for its structured-output path. The integration-test stage 4 smoke run is the gate.
- **No prompt body rewording.** Any temptation to "improve" the existing prompts during this pass is out of scope. Phase 1 is one variable at a time.
- **Risk LOW per `gitnexus_impact` on `lint_scan`** — single direct caller (`pipeline_lint_scan`), no signature change, no new dependency. Same shape applies to the other 6 prompts (each used by exactly one routing function).

## Test strategy

- **Pre-implementation:** capture the existing pass set on the prompt-touching tests as the green baseline
  - `pytest nlp-service/tests/test_llm_client.py -k "lint or extract or disambiguate or crossref or select_pages or synthesize" -v` — record passing test names
- **Per-task:** after each prompt edit, re-run the same selector; expect the same passing set
- **Phase exit:** `bash scripts/integration-test.sh --stage 4` against a known-good corpus source; entity-count output sanity-checked against expectations (no parse failures, no salvage attempts logged)

## Decomposition into tasks

**Task 1.1** — Add `_JSON_TRAILER` constant; append to `_LINT_SYSTEM_PROMPT`. Smallest reviewable diff that establishes the pattern.

**Task 1.2** — Append `+ _JSON_TRAILER` to the remaining 6 prompts. Mechanical follow-through.

Each task is a single commit. One file (`nlp-service/services/llm_client.py`) is modified across both tasks.

## References

- Master plan: [2026-05-05-deepseek-second-llm-provider.md](2026-05-05-deepseek-second-llm-provider.md) (Phase 1)
- Quirk #1 (DeepSeek json_object requires the keyword): master plan Context table
- Impact analysis ran 2026-05-05 on `lint_scan` — risk LOW, 1 direct caller
