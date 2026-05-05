# Phase 5 Spec — env wiring + /api/health provider_keys flags

**Plan:** [docs/plans/2026-05-05-deepseek-second-llm-provider.md](2026-05-05-deepseek-second-llm-provider.md)
**Branch:** `feat/multi-provider-llm`
**Status:** Active.
**Depends on:** Phase 4 (commit `6940235` — `DeepSeekProvider` exists; factory dispatches `deepseek-*` correctly; 184/184 tests green).

## Scope

Wire `DEEPSEEK_API_KEY` end-to-end so a real-world deployment can use the Phase 4 provider, and surface key presence to the Next.js front-end so Phase 6's Settings dropdown can gate the DeepSeek option correctly.

**In scope:**
- `docker-compose.yml`: add `DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY:-}` to both `app.environment` and `nlp-service.environment` blocks adjacent to existing `GEMINI_API_KEY` lines. The `${VAR:-}` empty-default form is required so docker compose doesn't fail on container start when the var is unset.
- `.env.example`: append `DEEPSEEK_API_KEY=` (empty default) + one-line comment pointing operators to `https://api-docs.deepseek.com` for key issuance.
- `scripts/integration-test.sh` Stage 1 env-loop: regression-guard `DEEPSEEK_API_KEY` alongside the existing `GEMINI_API_KEY` and `FIRECRAWL_API_KEY` checks. CLAUDE.md's gotcha is "every new `process.env.X` read needs a Stage 1 guard" — this closes that loop.
- `nlp-service/main.py`:
  - `startup_check` at [:86](../../nlp-service/main.py#L86): warn if **neither** `GEMINI_API_KEY` nor `DEEPSEEK_API_KEY` is set (today it warns only on missing `GEMINI_API_KEY`). The deprecated `@app.on_event("startup")` decorator stays — switching to FastAPI lifespan is a separate cleanup.
  - `HealthResponse` model + `/health` handler at [:102](../../nlp-service/main.py#L102): extend with `provider_keys: {gemini: bool, deepseek: bool}`.
- `app/src/app/api/health/route.ts`: extend the response body with `provider_keys: { gemini_present: !!process.env.GEMINI_API_KEY, deepseek_present: !!process.env.DEEPSEEK_API_KEY }`. Presence-only check; no outbound network probe.
- New unit test in `nlp-service/tests/test_main.py`: assert `/health` response includes `provider_keys` shape.

**Out of scope:**
- Settings UI dropdown changes (Phase 6).
- Live smoke against the real DeepSeek API (requires a paid key in CI; deferred to Phase 7).
- Renaming `GEMINI_*` env vars to `LLM_*` (operator-facing breaking change, deferred per master plan).
- Switching `@app.on_event("startup")` to FastAPI's lifespan handler.
- `nlp-service` lifespan-time validation that the key actually authenticates against the upstream API (presence-only, matches Gemini's existing pattern).

## Data contracts

### `nlp-service/main.py` `/health` response

```python
class _ProviderKeys(BaseModel):
    gemini: bool
    deepseek: bool

class HealthResponse(BaseModel):
    status: str
    provider_keys: _ProviderKeys


@app.get("/health", response_model=HealthResponse)
def health() -> HealthResponse:
    return HealthResponse(
        status="ok",
        provider_keys=_ProviderKeys(
            gemini=bool(os.environ.get("GEMINI_API_KEY", "").strip()),
            deepseek=bool(os.environ.get("DEEPSEEK_API_KEY", "").strip()),
        ),
    )
```

### `app/src/app/api/health/route.ts` extension

Add to the existing JSON response:

```ts
provider_keys: {
  gemini_present: !!process.env.GEMINI_API_KEY,
  deepseek_present: !!process.env.DEEPSEEK_API_KEY,
},
```

The two endpoints intentionally use different field names — nlp-service `gemini`/`deepseek` and Next.js `gemini_present`/`deepseek_present`. Phase 6's Settings UI reads the Next.js endpoint; the nlp-service endpoint is for operator/CI inspection.

### `docker-compose.yml` block

Two adjacent additions:

```yaml
services:
  app:
    environment:
      GEMINI_API_KEY: ${GEMINI_API_KEY:-}
      DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY:-}
      # ...existing entries
  nlp-service:
    environment:
      GEMINI_API_KEY: ${GEMINI_API_KEY:-}
      DEEPSEEK_API_KEY: ${DEEPSEEK_API_KEY:-}
      # ...existing entries
```

### `scripts/integration-test.sh` Stage 1 env-loop

Stage 1 today loops over `GEMINI_API_KEY` and `FIRECRAWL_API_KEY` checking that the host env var (when set) actually reaches the container. Extend the loop with `DEEPSEEK_API_KEY`. The check is host-side only; absence is accepted (skip), but presence-without-pass-through is a fail.

## Public API / tool / config changes

The `/health` and `/api/health` endpoints gain a new field. Existing clients that don't read `provider_keys` are unaffected. Phase 6 will be the first reader.

## Success criteria

1. `docker compose -f docker-compose.yml config` exits 0; both `GEMINI_API_KEY` and `DEEPSEEK_API_KEY` substituted in both `app` and `nlp-service` environment blocks.
2. `curl http://localhost:8000/health | jq .provider_keys` returns `{"gemini": <bool>, "deepseek": <bool>}` after the rebuild.
3. `curl http://localhost:3000/api/health | jq .provider_keys` returns `{"gemini_present": <bool>, "deepseek_present": <bool>}`.
4. `bash scripts/integration-test.sh` stage 1 passes with `DEEPSEEK_API_KEY` set; loop guards against the regression where a `process.env.DEEPSEEK_API_KEY` read in Node code goes to `undefined` because compose forgot to substitute.
5. `pytest nlp-service/tests/` + provider tests — all green (target 184+ + new test).
6. `nlp-service` startup_check warns on stderr when neither `GEMINI_API_KEY` nor `DEEPSEEK_API_KEY` is set.

## Out-of-scope items

(See Scope.) Phase 6 wires the UI; Phase 7 runs corpus revalidation.

## Safety constraints

- **Empty-default for env vars (`${VAR:-}`).** Without it, `docker compose` fails to start the container when `DEEPSEEK_API_KEY` is unset in the host shell — that's the failure mode the CLAUDE.md gotcha explicitly warns about.
- **Presence-only health check.** No outbound network probe to either provider. Validating the key's actual authentication needs a paid call which we don't want in `/health` (it's polled).
- **Stage 1 host-side check, not container-side.** Stage 1 verifies the host env reaches the container; a host that lacks the key just skips the check rather than failing. This matches the existing pattern.
- **No behavior change for sessions that don't use DeepSeek.** Operators who only set `GEMINI_API_KEY` see no functional difference; the `/health` flag just shows `deepseek: false`.

## Test strategy

### Pre-implementation
- Baseline: 184/184 green (commit `6940235`).

### Per-task
- **5.1 (compose + .env.example + integration-test):** verification is `docker compose -f docker-compose.yml config` exit 0 and `bash scripts/integration-test.sh` stages 0/1/4 PASS after rebuild.
- **5.2 (nlp-service /health):** RED test in `nlp-service/tests/test_main.py` asserting `provider_keys` shape; implement; GREEN.
- **5.3 (Next.js /api/health):** smoke via `curl` after rebuild; the existing route has no unit test surface in the app TypeScript suite.

### Phase exit
- Full nlp-service test suite green (185+).
- `docker compose -f docker-compose.yml config` exit 0.
- Manual `curl` checks for both health endpoints.
- Integration stages 0/1/4 PASS after rebuild.

## Decomposition

**Task 5.1** — compose + `.env.example` + integration-test stage 1 guard. Single commit; pure config wiring; no Python/TS code changes.

**Task 5.2** — nlp-service `main.py` startup_check + `/health` response. RED→GREEN test. Single commit.

**Task 5.3** — Next.js `/api/health` extension. Single commit.

(Or one bundled commit for all three since the changes are small and sequential. Bundle if total diff is under ~80 LOC.)

## References

- Master plan: [2026-05-05-deepseek-second-llm-provider.md](2026-05-05-deepseek-second-llm-provider.md) (Phase 5)
- Phase 4 commit: `6940235`
- Phase 4 spec: [phase_4_spec.md](phase_4_spec.md)
- CLAUDE.md gotcha: "New `process.env.X` reads need a `docker-compose.yml` `app.environment` entry" — Stage 1 of `scripts/integration-test.sh` regression-guards `GEMINI_API_KEY` + `FIRECRAWL_API_KEY`; extend the loop.
- DeepSeek API key issuance: `https://api-docs.deepseek.com` (mentioned in `.env.example` comment for operator self-discovery)
