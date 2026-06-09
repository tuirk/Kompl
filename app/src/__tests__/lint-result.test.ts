import { describe, it, expect } from 'vitest';
import { normalizeLintResult, lintCounts, legacyCountHint } from '../lib/lint-result';

describe('normalizeLintResult', () => {
  it('parses new-shape payload with arrays', () => {
    const raw = {
      orphan_pages: [{ page_id: 'p1', title: 'Alpha' }],
      stale_pages: [],
      missing_cross_refs: [],
      dead_provenance: [],
      contradictions: [],
      run_duration_ms: 42,
    };
    const r = normalizeLintResult(raw);
    expect(r?.orphan_pages).toHaveLength(1);
    expect(r?.orphan_pages[0].title).toBe('Alpha');
    expect(r?.run_duration_ms).toBe(42);
  });

  it('legacy counts yield empty arrays', () => {
    const raw = {
      orphan_pages: 5,
      stale_pages: 2,
      missing_cross_refs: [],
      dead_provenance: 1,
      contradiction_count: 3,
      run_duration_ms: 10,
    };
    const r = normalizeLintResult(raw);
    expect(r?.orphan_pages).toEqual([]);
    expect(r?.contradictions).toEqual([]);
  });

  it('lintCounts reads legacy fallback when arrays empty', () => {
    const raw = {
      orphan_pages: 5,
      stale_pages: 2,
      missing_cross_refs: [{ entity_text: 'Foo', mention_count: 3 }],
      dead_provenance: 1,
      contradiction_count: 3,
      run_duration_ms: 10,
    };
    const r = normalizeLintResult(raw)!;
    const c = lintCounts(r, raw);
    expect(c.orphans).toBe(5);
    expect(c.stale).toBe(2);
    expect(c.crossRefs).toBe(1);
    expect(c.deadProv).toBe(1);
    expect(c.contradictions).toBe(3);
  });

  it('returns null for null input', () => {
    expect(normalizeLintResult(null)).toBeNull();
  });

  it('parses enriched contradictions', () => {
    const raw = {
      orphan_pages: [],
      stale_pages: [],
      missing_cross_refs: [],
      dead_provenance: [],
      contradictions: [{
        page_a_id: 'a',
        page_a_title: 'Page A',
        page_b_id: 'b',
        page_b_title: 'Page B',
        claim: 'They disagree',
        severity: 'major',
      }],
      run_duration_ms: 1,
    };
    const r = normalizeLintResult(raw);
    expect(r?.contradictions[0].claim).toBe('They disagree');
  });
});

describe('legacyCountHint', () => {
  it('true when legacy count exists but array empty', () => {
    expect(legacyCountHint(5, 0)).toBe(true);
    expect(legacyCountHint(0, 0)).toBe(false);
    expect(legacyCountHint(5, 3)).toBe(false);
  });
});
