# Phase 6 Spec — Settings UI: optgrouped dropdowns gated by /api/health

**Plan:** [docs/plans/2026-05-05-deepseek-second-llm-provider.md](2026-05-05-deepseek-second-llm-provider.md)
**Branch:** `feat/multi-provider-llm`
**Status:** Active.
**Depends on:** Phase 5 (commit `f876fbb` — `/api/health` exposes `provider_keys: {gemini_present, deepseek_present}`; nlp-service `/health` mirrors with `{gemini, deepseek}`; 188/188 tests green).

## Scope

Light up the Settings dropdown so an operator can pick DeepSeek as the compile or chat model. Phase 4 made `get_provider("deepseek-v4-pro")` work end-to-end; Phase 5 surfaced the key-presence flag; Phase 6 wires the front-end. The per-session lock at [app/src/lib/db.ts:1447](../../app/src/lib/db.ts#L1447) `getEffectiveCompileModel` already accepts arbitrary model strings (the `compile_progress.compile_model` column does too — migration v20). No DB schema work.

**In scope:**
- `app/src/lib/db.ts` — expand `CHAT_MODELS` const at [:2530-2534](../../app/src/lib/db.ts#L2530) to include `'deepseek-v4-pro'`. `isChatModel` validator at [:2538](../../app/src/lib/db.ts#L2538) automatically picks up the new entry. Add `getProviderForModel(m: string): 'gemini' | 'deepseek'` helper based on prefix.
- `app/src/app/api/settings/route.ts` — error strings at [:228, :238](../../app/src/app/api/settings/route.ts#L228) list the expanded model set. Validation already routes through `isChatModel`.
- `app/src/app/settings/page.tsx` — restructure the compile + chat `<select>` blocks ([:1095-1112, :1160-1177](../../app/src/app/settings/page.tsx#L1095)) with grouped `<optgroup label="Gemini">` and `<optgroup label="DeepSeek">`. The DeepSeek option `disabled={!healthData?.provider_keys?.deepseek_present}` + `title=` tooltip directing the operator to set the env var. Update copy ([:1083-1092, :1152-1156](../../app/src/app/settings/page.tsx#L1083)) to drop the word "Gemini" — the descriptions become provider-neutral. Health data fetched via the existing settings page load (no new API call).
- Manual four-corner matrix walk in the dev server: only-Gemini / only-DeepSeek / both / neither — confirm the dropdown disabled+tooltip states match expectation.

**Out of scope:**
- Live extraction smoke against DeepSeek through the UI flow (Phase 7).
- Adding new vitest coverage for the page component (the existing test surface for `settings/page.tsx` is light; Phase 6 verification leans on typecheck + manual matrix).
- Changing `DEFAULT_COMPILE_MODEL` / `DEFAULT_CHAT_MODEL` away from Gemini ([app/src/lib/db.ts:2536-2562](../../app/src/lib/db.ts#L2536)). Gemini remains the default — operators self-select DeepSeek per session.
- Onboarding-flow strictness changes (require at least one provider key before finalize). Master plan defers; UI tooltip is sufficient operator self-discovery.
- Adding extra test coverage for the route handler at `app/src/app/api/settings/route.ts` — the change is a string update, validation already covered.

## Data contracts

### `app/src/lib/db.ts` `CHAT_MODELS` + helper

```ts
export const CHAT_MODELS = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'deepseek-v4-pro',
] as const;
export type ChatModel = typeof CHAT_MODELS[number];

// existing isChatModel at :2538 still works — readonly array contains check.

export function getProviderForModel(m: string): 'gemini' | 'deepseek' {
  if (m.startsWith('deepseek-')) return 'deepseek';
  return 'gemini';
}
```

### `app/src/app/api/settings/route.ts` validator messages

The existing message strings list valid models verbatim:

```ts
{ error: 'chat_model must be one of: gemini-2.5-flash-lite, gemini-2.5-flash, gemini-2.5-pro' }
```

Update to:

```ts
{ error: 'chat_model must be one of: gemini-2.5-flash-lite, gemini-2.5-flash, gemini-2.5-pro, deepseek-v4-pro' }
```

(Same change for `compile_model` at [:238](../../app/src/app/api/settings/route.ts#L238).)

The validator predicate `isChatModel` already returns true for `'deepseek-v4-pro'` because it's now in `CHAT_MODELS` — the message string is the only edit.

### `app/src/app/settings/page.tsx` dropdown structure

Both compile + chat selects become:

```tsx
<select value={compileModel} onChange={…}>
  <optgroup label="Gemini">
    <option value="gemini-2.5-flash-lite">Flash Lite (cheapest)</option>
    <option value="gemini-2.5-flash">Flash (default)</option>
    <option value="gemini-2.5-pro">Pro (highest quality)</option>
  </optgroup>
  <optgroup label="DeepSeek">
    <option
      value="deepseek-v4-pro"
      disabled={!healthData?.provider_keys?.deepseek_present}
      title={healthData?.provider_keys?.deepseek_present
        ? undefined
        : 'Set DEEPSEEK_API_KEY in your environment to enable'}
    >
      V4 Pro
    </option>
  </optgroup>
</select>
```

The `healthData` is already fetched on settings page load (used for the daily-cap display). No new API call added; just one new field read.

### Provider-neutral copy

Today's copy for the compile dropdown describes "the Gemini model that the compile pipeline uses..." — drop "Gemini" so the description fits both providers. Same edit for the chat dropdown copy ([:1152-1156](../../app/src/app/settings/page.tsx#L1152)).

## Public API / tool / config changes

`app/src/app/api/settings/route.ts` POST handler now accepts `'deepseek-v4-pro'` as a valid value for both `chat_model` and `compile_model`. Existing 422 responses for invalid values include the new model in the error message.

The settings persist into the existing `settings` table (which stores arbitrary string values for `chat_model` / `compile_model` keys); migration v20's `compile_progress.compile_model` column also accepts any string. No DB changes.

## Success criteria

1. `cd app && npm run typecheck` exits 0 — the new `'deepseek-v4-pro'` entry types correctly through `ChatModel`, `isChatModel`, `getCompileModel`, `getEffectiveCompileModel`.
2. Both dropdowns render with `<optgroup label="Gemini">` and `<optgroup label="DeepSeek">`.
3. DeepSeek option's `disabled` + `title` attributes flip based on `healthData?.provider_keys?.deepseek_present`.
4. POST `/api/settings` with `{compile_model: "deepseek-v4-pro"}` saves successfully.
5. POST `/api/settings` with `{compile_model: "invalid-model"}` returns 422 with an error message that includes `'deepseek-v4-pro'` in the valid-list.
6. Manual four-corner matrix walked end-to-end:
   - Only `GEMINI_API_KEY`: DeepSeek option appears disabled with tooltip; selecting Gemini saves cleanly
   - Only `DEEPSEEK_API_KEY`: Gemini options disabled with tooltips; selecting DeepSeek saves
   - Both keys: both selectable
   - Neither: both groups disabled
7. Per-session lock: kicking off a compile after selecting DeepSeek writes `deepseek-v4-pro` to `compile_progress.compile_model` (the lock survives mid-session Settings changes — verified via the existing per-session-lock pattern at [getEffectiveCompileModel](../../app/src/lib/db.ts#L1447)).

## Out-of-scope items

(See Scope.) Phase 7 covers the corpus revalidation; Phase 6 stops at "the operator can pick the option without saving an invalid value."

## Safety constraints

- **Disabled options must be visibly distinct** — tooltip + `disabled` attribute are necessary so an operator on a Gemini-only deployment doesn't get a 422 from the POST after a save attempt that only the back-end will reject.
- **Per-session lock keeps mid-session model swaps disabled** — the lock has been there since migration v20; this phase doesn't change that. CLAUDE.md gotcha: cancel + restart to switch.
- **Default stays on Gemini.** `DEFAULT_COMPILE_MODEL = 'gemini-2.5-flash'` / `DEFAULT_CHAT_MODEL = 'gemini-2.5-flash-lite'`. Operators must opt into DeepSeek; no surprise switches.
- **Gemini-prefix options on a DeepSeek-only deployment must also be disabled.** Symmetry: if an operator has only `DEEPSEEK_API_KEY` set (`gemini_present: false`), the Gemini options are disabled with the same tooltip pattern. Otherwise the operator could save a Gemini selection that the back-end will fail on every call.

## Test strategy

### Pre-implementation
- Baseline: 188/188 nlp + provider tests green; vitest in `app/` and `cli/` green (CI confirms).

### Per-task
- **6.1 (db.ts + helper):** typecheck + run any existing vitest that imports `CHAT_MODELS`.
- **6.2 (settings/route.ts):** run vitest `app/`; existing test surface validates the route handler.
- **6.3 (settings/page.tsx):** typecheck + manual render in dev server; the Settings page has no automated component-level test today.
- **6.4 (manual matrix):** four-corner walk recorded in the PR description.

### Phase exit
- `cd app && npm run typecheck` exit 0.
- `cd app && npx vitest run` — green (the existing test surface).
- Four-corner manual matrix recorded.
- Save + reload: `compile_model = 'deepseek-v4-pro'` round-trips through `/api/settings` GET/POST.

## Decomposition

**Task 6.1** — `app/src/lib/db.ts` `CHAT_MODELS` expansion + `getProviderForModel` helper.

**Task 6.2** — `app/src/app/api/settings/route.ts` error string update (mechanical follow-on).

**Task 6.3** — `app/src/app/settings/page.tsx` optgroup restructure + gating + provider-neutral copy. Largest of the three.

Bundle as one commit: the three files form a single logical change ("expose DeepSeek in Settings dropdown"). Per the master plan's discipline ("one commit per phase task"), Phase 6 ships as one or two commits — bundling makes the diff easier to review.

## References

- Master plan: [2026-05-05-deepseek-second-llm-provider.md](2026-05-05-deepseek-second-llm-provider.md) (Phase 6)
- Phase 5 spec: [phase_5_spec.md](phase_5_spec.md)
- Phase 5 commit: `f876fbb`
- Per-session lock pattern: [app/src/lib/db.ts:1447](../../app/src/lib/db.ts#L1447) `getEffectiveCompileModel`
- `compile_progress.compile_model` column: migration v20 (already accepts any string)
- Health endpoint: [app/src/app/api/health/route.ts](../../app/src/app/api/health/route.ts) — `provider_keys: {gemini_present, deepseek_present}` shipped in Phase 5
