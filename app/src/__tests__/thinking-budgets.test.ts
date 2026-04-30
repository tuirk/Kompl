import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { readFileSync, existsSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';
import {
  DATA_ROOT,
  getThinkingBudgets,
  setThinkingBudgets,
  setDailyCapUsd,
  THINKING_BUDGET_KEYS,
} from '../lib/db';
import { setupTestDb, type TestDbHandle } from './helpers/test-db';

const LLM_CONFIG_PATH = join(DATA_ROOT, 'llm-config.json');

describe('thinking_budgets settings', () => {
  let handle: TestDbHandle;

  beforeEach(() => {
    handle = setupTestDb();
    if (existsSync(LLM_CONFIG_PATH)) unlinkSync(LLM_CONFIG_PATH);
  });

  afterEach(() => {
    handle.cleanup();
    if (existsSync(LLM_CONFIG_PATH)) unlinkSync(LLM_CONFIG_PATH);
  });

  it('returns code-baked defaults when nothing has been saved', () => {
    const budgets = getThinkingBudgets();
    // Defaults must match what nlp-service/services/llm_client.py shipped with —
    // the whole point of switching to settings is to NOT change runtime behaviour
    // until the user opts in via the UI.
    expect(budgets.extract_source).toBe(512);
    expect(budgets.draft_page).toBe(1024);
    expect(budgets.disambiguate_entities).toBe(512);
    expect(budgets.synthesize_answer).toBe(512);
    expect(budgets.lint_scan).toBe(1024);
    expect(budgets.select_pages_for_query).toBe(1024);
    expect(budgets.generate_schema).toBe(2048);
    expect(budgets.crossref_pages).toBe(0);
    expect(budgets.triage_page_update).toBe(0);
    expect(budgets.generate_digest).toBe(1024);
    // All 10 keys present.
    expect(Object.keys(budgets).sort()).toEqual([...THINKING_BUDGET_KEYS].sort());
  });

  it('merges patches with existing values, leaves untouched keys at default', () => {
    setThinkingBudgets({ draft_page: -1 });
    const after = getThinkingBudgets();
    expect(after.draft_page).toBe(-1);
    // Other keys must keep their defaults.
    expect(after.extract_source).toBe(512);
    expect(after.crossref_pages).toBe(0);
  });

  it('mirrors values into /data/llm-config.json so nlp-service can read them', () => {
    setThinkingBudgets({ extract_source: -1, crossref_pages: 256 });
    expect(existsSync(LLM_CONFIG_PATH)).toBe(true);
    const onDisk = JSON.parse(readFileSync(LLM_CONFIG_PATH, 'utf-8'));
    expect(onDisk.thinking_budgets.extract_source).toBe(-1);
    expect(onDisk.thinking_budgets.crossref_pages).toBe(256);
    // Untouched keys still mirrored at their defaults.
    expect(onDisk.thinking_budgets.draft_page).toBe(1024);
  });

  it('rejects out-of-range values without corrupting good keys', () => {
    setThinkingBudgets({
      // valid
      draft_page: 4096,
      // invalid: > 24576 cap
      extract_source: 99999,
      // invalid: < -1
      lint_scan: -2,
      // invalid type silently coerced is the kind of bug we DO NOT want — the
      // helper filters non-integers out, so the existing default survives.
      crossref_pages: 1.5 as unknown as number,
    });
    const after = getThinkingBudgets();
    expect(after.draft_page).toBe(4096);
    expect(after.extract_source).toBe(512);   // default — invalid value rejected
    expect(after.lint_scan).toBe(1024);       // default
    expect(after.crossref_pages).toBe(0);     // default
  });

  it('does not clobber daily_cap_usd when thinking_budgets are saved', () => {
    setDailyCapUsd(7.5);
    setThinkingBudgets({ draft_page: -1 });
    const onDisk = JSON.parse(readFileSync(LLM_CONFIG_PATH, 'utf-8'));
    // Both keys must coexist — pre-fix, setThinkingBudgets's writeFileSync
    // would have overwritten the file with just thinking_budgets and lost
    // the daily_cap_usd that nlp-service relies on for cost enforcement.
    expect(onDisk.daily_cap_usd).toBe(7.5);
    expect(onDisk.thinking_budgets.draft_page).toBe(-1);
  });

  it('does not clobber thinking_budgets when daily_cap_usd is saved', () => {
    setThinkingBudgets({ draft_page: -1 });
    setDailyCapUsd(3.0);
    const onDisk = JSON.parse(readFileSync(LLM_CONFIG_PATH, 'utf-8'));
    expect(onDisk.daily_cap_usd).toBe(3.0);
    expect(onDisk.thinking_budgets.draft_page).toBe(-1);
  });

  it('rejects unknown keys silently in setThinkingBudgets', () => {
    setThinkingBudgets({ bogus_key: 1234 } as Partial<Record<string, number>> as never);
    const after = getThinkingBudgets();
    expect((after as Record<string, number>).bogus_key).toBeUndefined();
  });
});
