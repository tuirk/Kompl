import { describe, expect, it } from 'vitest';
import {
  evaluateHealth,
  type HealthApiResponse,
} from '../lib/onboarding-health-evaluator';

const allGreen: HealthApiResponse = {
  status: 'ok',
  nlp_ok: true,
  provider_keys: { gemini_present: true, deepseek_present: true },
  selected_compile_model: 'gemini-2.5-flash',
  selected_compile_provider: 'gemini',
  integration_keys: { firecrawl_present: true, youtube_present: true },
};

describe('evaluateHealth — all checks pass', () => {
  it('every row has status pass when everything is wired', () => {
    const rows = evaluateHealth(allGreen);
    expect(rows.every((r) => r.status === 'pass')).toBe(true);
  });

  it('returns exactly four rows in stable order', () => {
    const rows = evaluateHealth(allGreen);
    expect(rows.map((r) => r.id)).toEqual([
      'nlp',
      'selected_provider',
      'firecrawl',
      'youtube',
    ]);
  });

  it('every row has a non-empty label', () => {
    const rows = evaluateHealth(allGreen);
    for (const r of rows) {
      expect(r.label.length).toBeGreaterThan(0);
    }
  });
});

describe('evaluateHealth — nlp_unreachable', () => {
  it('nlp_ok=false produces a red failing row with code nlp_unreachable', () => {
    const rows = evaluateHealth({ ...allGreen, nlp_ok: false });
    const r = rows.find((row) => row.id === 'nlp');
    expect(r).toBeDefined();
    expect(r!.severity).toBe('red');
    expect(r!.status).toBe('fail');
    expect(r!.code).toBe('nlp_unreachable');
  });
});

describe('evaluateHealth — selected provider', () => {
  it('gemini selected + gemini key missing → red fail (selected_provider_key_missing)', () => {
    const rows = evaluateHealth({
      ...allGreen,
      selected_compile_model: 'gemini-2.5-flash',
      selected_compile_provider: 'gemini',
      provider_keys: { gemini_present: false, deepseek_present: true },
    });
    const r = rows.find((row) => row.id === 'selected_provider');
    expect(r).toBeDefined();
    expect(r!.severity).toBe('red');
    expect(r!.status).toBe('fail');
    expect(r!.code).toBe('selected_provider_key_missing');
  });

  it('gemini selected + gemini key present + deepseek absent → row passes (other provider irrelevant)', () => {
    const rows = evaluateHealth({
      ...allGreen,
      selected_compile_model: 'gemini-2.5-flash',
      selected_compile_provider: 'gemini',
      provider_keys: { gemini_present: true, deepseek_present: false },
    });
    const r = rows.find((row) => row.id === 'selected_provider');
    expect(r!.status).toBe('pass');
  });

  it('deepseek selected + deepseek key missing → red fail', () => {
    const rows = evaluateHealth({
      ...allGreen,
      selected_compile_model: 'deepseek-v4-pro',
      selected_compile_provider: 'deepseek',
      provider_keys: { gemini_present: true, deepseek_present: false },
    });
    const r = rows.find((row) => row.id === 'selected_provider');
    expect(r!.severity).toBe('red');
    expect(r!.status).toBe('fail');
    expect(r!.code).toBe('selected_provider_key_missing');
  });

  it('deepseek selected + deepseek key present + gemini absent → row passes', () => {
    const rows = evaluateHealth({
      ...allGreen,
      selected_compile_model: 'deepseek-v4-pro',
      selected_compile_provider: 'deepseek',
      provider_keys: { gemini_present: false, deepseek_present: true },
    });
    const r = rows.find((row) => row.id === 'selected_provider');
    expect(r!.status).toBe('pass');
  });

  it('row label includes the selected model name (visibility)', () => {
    const rows = evaluateHealth({
      ...allGreen,
      selected_compile_model: 'deepseek-v4-pro',
      selected_compile_provider: 'deepseek',
    });
    const r = rows.find((row) => row.id === 'selected_provider');
    expect(r!.label).toContain('deepseek-v4-pro');
  });
});

describe('evaluateHealth — integration keys (amber)', () => {
  it('firecrawl missing → amber fail with code firecrawl_key_missing', () => {
    const rows = evaluateHealth({
      ...allGreen,
      integration_keys: { firecrawl_present: false, youtube_present: true },
    });
    const r = rows.find((row) => row.id === 'firecrawl');
    expect(r!.severity).toBe('amber');
    expect(r!.status).toBe('fail');
    expect(r!.code).toBe('firecrawl_key_missing');
  });

  it('youtube missing → amber fail with code youtube_key_missing', () => {
    const rows = evaluateHealth({
      ...allGreen,
      integration_keys: { firecrawl_present: true, youtube_present: false },
    });
    const r = rows.find((row) => row.id === 'youtube');
    expect(r!.severity).toBe('amber');
    expect(r!.status).toBe('fail');
    expect(r!.code).toBe('youtube_key_missing');
  });
});
