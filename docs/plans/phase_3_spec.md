# Phase 3 Spec — messages=[system, user] conversion + per-provider input cap + Gemini-only halved fallback

**Plan:** [docs/plans/2026-05-05-deepseek-second-llm-provider.md](2026-05-05-deepseek-second-llm-provider.md)
**Branch:** `feat/multi-provider-llm`
**Status:** Active.
**Depends on:** Phase 2 (commits `ffd74ff`, `9e821e0`, `9c012d6` — `LLMProvider` Protocol live, `GeminiProvider` extracts done, all 11 call sites routed through `provider.complete(LLMRequest)`).

## Scope

Three changes that only make sense once the provider abstraction is in place:

**3.1** Convert the call sites that today concatenate ``f"{SYSTEM_PROMPT}\n\n---\n\n{USER}"`` and pass it as a single user message to the explicit ``messages=[{"role": "system", ...}, {"role": "user", ...}]`` shape. This makes both providers cache better (Gemini ``system_instruction`` is independently cached; DeepSeek's ``json_object`` mode is most reliable with explicit roles) and is a pre-commitment to Phase 4's DeepSeek wiring. The 6 call sites with a corresponding ``_*_SYSTEM_PROMPT`` constant currently do this — 4 still concatenate (3 unique call sites, plus the halved-input fallback inside extract_source); the other 2 (crossref_pages, synthesize_answer) already use system_instruction and pass through Phase 2's adapter as ``messages=[system, user]``. Phase 3 converts the remaining 4.

**3.2** Add a per-provider input-character cap. Empirical: DeepSeek extracted clean from a 95K-char source where Gemini hits MAX_TOKENS at 50K. Today ``_GEMINI_EXTRACT_INPUT_CAP=50000`` is hardcoded and applied unconditionally. After Phase 4 ships, a session locked to ``deepseek-v4-pro`` should get a 200K cap; Gemini sessions stay at 50K.

**3.3** Gate the halved-input fallback path in ``extract_source`` by the ``gemini-*`` prefix. The fallback's "different prompt path escapes the loop" rationale is Gemini-bug-specific (the 2.5 Flash sampler enters a fixed-point attractor at MAX_TOKENS); Phase 4's DeepSeek doesn't have that pathology, and the empirical 28-call spike showed ``_salvage_extraction`` already covers any rare DeepSeek failure adequately. Halving on DeepSeek would just double cost on a failure path with no benefit.

**In scope:**
- 4 call sites in ``nlp-service/services/llm_client.py`` switching from concatenated prompt to ``messages=[system, user]``:
  - ``lint_scan`` (line ~325)
  - ``extract_source`` first call (line ~495)
  - ``extract_source`` halved-input fallback (line ~575)
  - ``disambiguate_entities`` (line ~717)
  - ``select_pages_for_query`` (line ~1306)
  - (5 sites total once you count the halved-input fallback as its own conversion)
- New ``_DEEPSEEK_INPUT_CHAR_CAP = int(os.environ.get("DEEPSEEK_INPUT_CHAR_CAP", "200000"))`` in ``llm_client.py``
- New helper ``_extract_input_cap_for(model: str) -> int`` that returns the right cap by model prefix
- Gate the halved-input fallback in ``extract_source`` by ``model.startswith("gemini-")``; DeepSeek path raises ``LLMCompileError`` with the original parse error if salvage fails
- Tests: assert that 5 call sites pass the explicit ``messages=[system, user]`` shape via the SDK adapter; assert ``_extract_input_cap_for`` mapping; assert Gemini-only halved-fallback gating

**Out of scope:**
- Triage call site (``triage_page_update``) — its prompt has no module-level system constant; the entire instruction is constructed inline. Phase 3 leaves it as a single user message. Splitting it requires creating a new ``_TRIAGE_SYSTEM_PROMPT`` constant which is a separate concern.
- ``draft_page``, ``generate_schema``, ``crossref_pages``, ``synthesize_answer`` — Phase 2 already passes ``messages=[system, user]`` for these (they were never concatenated to begin with).
- ``generate_digest`` — single user message, no separate system prompt; not converted.
- DeepSeek implementation (Phase 4) — only the prefix gate lands here; the actual provider class stays out.
- Removing ``_GEMINI_EXTRACT_INPUT_CAP`` — keep both constants; the helper picks the right one based on model.

## Data contracts

### `messages=[system, user]` shape per call site

Pattern (apply 5×):
```python
provider = get_provider(model)
result = provider.complete(LLMRequest(
    model=model,
    messages=[
        {"role": "system", "content": _LINT_SYSTEM_PROMPT},   # the constant
        {"role": "user",   "content": user_payload},          # the data only
    ],
    response_model=...,
    thinking_budget=_read_thinking_budget('lint_scan'),
    max_output_tokens=4096,
    step="lint",
    extra={"force_json_mime": True},  # or response_model=Schema, depending on call site
))
```

Today's GeminiProvider adapter (in ``providers/gemini.py``) already routes ``messages[0].role == "system"`` to the genai SDK's ``system_instruction`` parameter and the user content to ``contents``. So the wire-level outcome is:

- **Before (Phase 2):** ``client.models.generate_content(model=…, contents=f"{SYS}\n\n---\n\n{USER}", config=GenerateContentConfig(response_schema=…, thinking_config=…))``
- **After (Phase 3):** ``client.models.generate_content(model=…, contents=USER, config=GenerateContentConfig(system_instruction=SYS, response_schema=…, thinking_config=…))``

This **is** a wire-level shape change. Gemini handles ``system_instruction`` as a top-level parameter that is independently cached and prepended to the model's instruction context; concatenated text mixes it in with the user input. In our internal experience the two shapes produce semantically equivalent output for our extraction prompts, but it is not byte-for-byte identical at the model. The verification path is the integration test stage 4 smoke + a baseline JSON diff against a recorded fixture — Phase 3's exit criterion.

### `_DEEPSEEK_INPUT_CHAR_CAP` + `_extract_input_cap_for`

```python
_DEEPSEEK_INPUT_CHAR_CAP = int(os.environ.get("DEEPSEEK_INPUT_CHAR_CAP", "200000"))


def _extract_input_cap_for(model: str) -> int:
    """Char cap on the source-document input passed to extract_source.

    DeepSeek empirically handles 95K-char inputs clean (28-call spike); Gemini
    hits MAX_TOKENS at 50K because of the structured-output repetition-loop
    bug. Each provider gets the cap that matches its real-world capacity.
    """
    if model.startswith("deepseek-"):
        return _DEEPSEEK_INPUT_CHAR_CAP
    return _GEMINI_EXTRACT_INPUT_CAP
```

The existing ``markdown = markdown[:_GEMINI_EXTRACT_INPUT_CAP]`` truncation in ``extract_source`` becomes ``markdown = markdown[:_extract_input_cap_for(model)]``.

### Halved-fallback gate

In ``extract_source`` the entire halved-input retry block (the "If MAX_TOKENS, retry once with halved input" path) gets wrapped:

```python
if not model.startswith("gemini-"):
    # DeepSeek and any future provider: salvage already failed above; don't
    # double the cost retrying with halved input on a different upstream bug
    # we have no evidence exists. Surface the original parse error.
    raise LLMCompileError(f"extract_llm_parse_failed: {first_err}") from first_err

# Gemini halved-input fallback below — same code as before
```

## Public API / tool / config changes

None. No new env vars beyond ``DEEPSEEK_INPUT_CHAR_CAP`` (optional, has default). No FastAPI route changes. No DB schema. No settings keys. No docker-compose or n8n changes.

## Success criteria

1. The 5 call sites listed above all build their messages list with explicit ``role: "system"`` + ``role: "user"`` entries; no concatenated ``"\n\n---\n\n"`` prompt strings remain at any of those sites.
2. ``_DEEPSEEK_INPUT_CHAR_CAP`` and ``_extract_input_cap_for`` exist; ``extract_source`` calls the helper.
3. Halved-input fallback only runs when ``model.startswith("gemini-")``.
4. ``pytest nlp-service/tests/ nlp-service/services/providers/`` — all 169 tests stay green.
5. New tests in ``test_providers.py`` (or test_llm_client.py) cover:
   - ``_extract_input_cap_for`` returns ``_DEEPSEEK_INPUT_CHAR_CAP`` for ``deepseek-*`` models
   - ``_extract_input_cap_for`` returns ``_GEMINI_EXTRACT_INPUT_CAP`` for ``gemini-*`` models
   - Halved-fallback path is taken only on ``gemini-*`` (assert via mocked provider that the fallback is skipped for a hypothetical non-Gemini model)
6. ``bash scripts/integration-test.sh`` stages 0/1/4 — PASS.

## Out-of-scope items

(See Scope above.) Triage's lack of a module-level system constant is the most notable omission; address as a separate cleanup if/when DeepSeek validation surfaces a regression.

## Safety constraints

- **One commit per logical change.** 3.1 (messages-shape conversion) and 3.2+3.3 (input cap + halved-fallback gate) ship as two commits. Each leaves the suite 169/169 green.
- **No silent behaviour change.** The wire-level shape change in 3.1 is the riskiest single move in the whole multi-provider effort. The 169-test gate covers all unit paths; the integration stage-4 smoke covers the boot path. A live extraction baseline diff against ``nlp-service/test_corpus/`` is the third gate (Phase 7's full corpus revalidation, deferred).
- **DeepSeek halved-fallback gate must not be reachable by a Gemini caller.** The condition is ``not model.startswith("gemini-")`` — this is true for any unknown future provider too, which is the safer default (don't run a Gemini-bug-specific mitigation on a provider we haven't validated).

## Test strategy

### Pre-implementation
- Baseline: 169/169 green (commit ``9c012d6``).

### Per-task
- **3.1** Convert one call site at a time (or in tight batches), run the relevant pytest selector, confirm green before moving to the next. Existing tests don't pin the messages shape directly, so the bulk verification is "151/151 still green; mocks intercept correctly". Add a smoke assertion in ``test_providers.py`` that mocks ``GeminiProvider.complete`` and verifies one of the converted call sites passes ``messages[0]["role"] == "system"``.
- **3.2** RED: ``test_extract_input_cap_for_dispatches_by_prefix`` asserts gemini-* → 50000, deepseek-* → 200000.
- **3.3** RED: ``test_halved_fallback_only_runs_on_gemini`` mocks the provider to return a MAX_TOKENS result + parse failure, asserts the second ``provider.complete`` call is made for ``gemini-2.5-flash`` and is NOT made for ``deepseek-v4-pro``.

### Phase exit
- ``pytest nlp-service/tests/ nlp-service/services/providers/`` — 169+ green.
- ``bash scripts/integration-test.sh`` stages 0/1/4 — PASS.
- ``git diff main..HEAD -- nlp-service/services/llm_client.py`` shows the 5 call-site message-shape edits + the cap helper + the fallback gate; no other behaviour change.

## Decomposition

**Task 3.1** — Convert 5 call sites to ``messages=[system, user]`` shape. One commit (the changes are mechanical and the riskiest single conversion is ``extract_source``, which has the halved-input fallback as a sibling change in the same function — keeping them in one commit gives bisect a clean checkpoint).

**Task 3.2** — Add ``_DEEPSEEK_INPUT_CHAR_CAP`` + ``_extract_input_cap_for`` helper; switch ``extract_source`` to the helper.

**Task 3.3** — Gate the halved-input fallback by ``model.startswith("gemini-")``. Logically tied to 3.2 (both touch ``extract_source``); ship in the same commit.

## References

- Master plan: [2026-05-05-deepseek-second-llm-provider.md](2026-05-05-deepseek-second-llm-provider.md) (Phase 3)
- Phase 2 commits: ``ffd74ff``, ``9e821e0``, ``9c012d6``
- Phase 2 spec: [phase_2_spec.md](phase_2_spec.md)
- ``GeminiProvider.complete`` adapter: [providers/gemini.py](../../nlp-service/services/providers/gemini.py)
- 5-spike empirical: 28/28 ok, 0 salvage attempts on DeepSeek including 95K-char source — see master plan Context table
