/**
 * Settings > Wiki health: the health check no longer looks for contradictions
 * (the Disagreements check does). A result saved before that change keeps its
 * pairs in storage, but the card does not list them; it points to the
 * Disagreements check instead.
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import WikiLintResults from '../components/WikiLintResults';
import { normalizeLintResult } from '../lib/lint-result';

describe('Wiki health card and a result saved before contradictions moved out', () => {
  const saved = {
    orphan_pages: [],
    stale_pages: [],
    missing_cross_refs: [],
    dead_provenance: [],
    contradictions: [
      { page_a_id: 'a', page_a_title: 'Vilnius', page_b_id: 'b', page_b_title: 'Kaunas', claim: 'Which city is larger', severity: 'major' },
    ],
    run_duration_ms: 5,
  };

  it('does not list the old pairs and points to the Disagreements check', () => {
    const html = renderToString(
      createElement(WikiLintResults, { result: normalizeLintResult(saved), raw: saved, running: false }),
    );
    expect(html).not.toContain('Which city is larger');
    expect(html).not.toContain('/wiki/a');
    expect(html).toContain('href="#wiki-check"');
    expect(html).toContain('Disagreements between sources');
  });

  it('an old count-only result points there too', () => {
    const legacy = { orphan_pages: 0, stale_pages: 0, dead_provenance: 0, contradiction_count: 2, run_duration_ms: 1 };
    const html = renderToString(
      createElement(WikiLintResults, { result: normalizeLintResult(legacy), raw: legacy, running: false }),
    );
    expect(html).toContain('href="#wiki-check"');
  });

  it('a current result says nothing about contradictions', () => {
    const current = { ...saved, contradictions: [] };
    const html = renderToString(
      createElement(WikiLintResults, { result: normalizeLintResult(current), raw: current, running: false }),
    );
    expect(html).not.toContain('#wiki-check');
  });
});

describe('Wiki health card and a result saved by an older check', () => {
  const saved = {
    orphan_pages: [{ page_id: 'saved-links', title: 'Saved Links' }, { page_id: 'lonely', title: 'Lonely Page' }],
    stale_pages: [],
    missing_cross_refs: [{ entity_text: 'second', mention_count: 3 }, { entity_text: 'Hal Finney', mention_count: 4 }],
    dead_provenance: [],
    contradictions: [],
    run_duration_ms: 6425,
  };

  it('leaves out Saved Links and number words, and says when the check ran', () => {
    const html = renderToString(
      createElement(WikiLintResults, { result: normalizeLintResult(saved), raw: saved, running: false, ranAt: '2026-10-10T10:05:19.495Z' }),
    );
    expect(html).not.toContain('Saved Links');
    expect(html).toContain('Lonely Page');
    expect(html).not.toContain('>second<');
    expect(html).toContain('Hal Finney');
    expect(html).toContain('10 Oct 2026');
    expect(html).toContain('6425 ms');
  });
});
