/**
 * Page summaries as shown (lib/summary-text.ts): drafting labels ("[S1]")
 * and stored tokens ("[^id]") left in old summaries never reach a reader:
 * not on the wiki cards, search, the article's overview and description,
 * the graph's page panel, nor the page index the MCP tools read.
 */

import { renderToString } from 'react-dom/server';
import { createElement, Fragment } from 'react';
import { describe, expect, it } from 'vitest';
import { GET as getIndex } from '../app/api/wiki/index/route';
import { buildGraphModel } from '../lib/graph-model';
import { dropCitationLabels } from '../lib/summary-text';
import { renderInlineWikilinks, stripWikilinkBrackets } from '../lib/wikilink-render';
import { seedPage, setupTestDb } from './helpers/test-db';

describe('dropCitationLabels', () => {
  it('drops labels in every shape the model writes, with the space before them', () => {
    expect(dropCitationLabels('Seen in prompt-driven development [S1] and as a deciding factor [S2].'))
      .toBe('Seen in prompt-driven development and as a deciding factor.');
    expect(dropCitationLabels('Known for dining and parks [S1][S2].')).toBe('Known for dining and parks.');
    expect(dropCitationLabels('Two views [S1, S2]; one more [s3; S4].')).toBe('Two views; one more.');
    expect(dropCitationLabels('Created in 2009.[^5624ad54-0000-4000-8000-000000000000]')).toBe('Created in 2009.');
  });

  it('keeps everything else: plain brackets, links and text that only looks close', () => {
    for (const text of ['The Galaxy (S3) phone', 'See [S1](https://example.com)', 'Array [0] and [Step 1]', 'Plain text.']) {
      expect(dropCitationLabels(text)).toBe(text);
    }
  });
});

describe('where summaries are shown', () => {
  const summary = 'Capital of [[Lithuania]] with parks [S1][S2].';

  it('cards and search rows: plain text without labels', () => {
    expect(stripWikilinkBrackets(summary)).toBe('Capital of Lithuania with parks.');
  });

  it('the article overview: links kept, labels dropped', () => {
    const html = renderToString(createElement(Fragment, null, ...renderInlineWikilinks(summary, new Map([['lithuania', 'lt-1']]))));
    expect(html).toContain('href="/wiki/lt-1"');
    expect(html).not.toContain('[S1]');
    expect(html).toMatch(/with parks\.$/);
  });

  it('the graph page panel', () => {
    const model = buildGraphModel({
      nodes: [{ id: 'v', label: 'Vilnius', group: 'entity', category: 'Travel', source_count: 2, summary, last_updated: null, degree: 0 }],
      links: [], missing: [],
    });
    expect(model.byId.get('v')?.summary).toBe('Capital of Lithuania with parks.');
  });
});

describe('the page index (wiki sidebar, MCP search_wiki browse)', () => {
  it('serves summaries without labels', async () => {
    const handle = setupTestDb();
    try {
      seedPage(handle.db, { page_id: 'v', title: 'Vilnius', summary: 'Known for dining and parks [S1][S2].' });
      seedPage(handle.db, { page_id: 'k', title: 'Kaunas' });
      const body = (await (await getIndex(new Request('http://test/api/wiki/index'))).json()) as { pages: Array<{ page_id: string; summary: string | null }> };
      expect(body.pages.find((p) => p.page_id === 'v')?.summary).toBe('Known for dining and parks.');
      expect(body.pages.find((p) => p.page_id === 'k')?.summary).toBeNull();
    } finally {
      handle.cleanup();
    }
  });
});
