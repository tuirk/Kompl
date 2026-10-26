/**
 * GET /api/wiki/[page_id]/data — the page JSON behind MCP read_page. Pins
 * what agents rely on: [n] citations numbered like the page view (same body
 * pipeline, so an empty Contradictions section is dropped the same way),
 * sources with address and date, the page's connections, and its links and
 * backlinks (kept for MCP builds that predate connections).
 */

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it } from 'vitest';
import { GET } from '../app/api/wiki/[page_id]/data/route';
import { insertPageLink } from '../lib/db';
import { seedPage, seedProvenance, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

async function pageData(pageId: string) {
  const res = await GET(new Request(`http://test/api/wiki/${pageId}/data`), {
    params: Promise.resolve({ page_id: pageId }),
  });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

function setBody(pageId: string, markdown: string) {
  handle!.db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?').run(markdown, pageId);
}

describe('page data', () => {
  it('numbers citations, lists sources with address and date, and drops empty Contradictions', async () => {
    handle = setupTestDb();
    const db = handle.db;
    // Stored citations use real source ids (UUIDs).
    const paper = seedSource(db, { source_id: randomUUID(), title: 'Bitcoin paper', source_url: 'https://bitcoin.org/bitcoin.pdf' });
    seedPage(db, { page_id: 'pow', title: 'Proof of work', page_type: 'concept' });
    seedProvenance(db, 'pow', paper);
    setBody(
      'pow',
      ['---', 'title: Proof of work', '---', `Miners compete [^${paper}].`, '', '## Contradictions', '', 'None.'].join('\n')
    );

    const { status, body } = await pageData('pow');
    expect(status).toBe(200);
    expect(body.content).toBe('Miners compete[1].');
    expect(body.sources).toEqual([
      {
        n: 1,
        source_id: paper,
        title: 'Bitcoin paper',
        contribution_type: 'created',
        source_url: 'https://bitcoin.org/bitcoin.pdf',
        date: expect.any(String),
      },
    ]);
  });

  it('lists the pages it links to and the pages linking here', async () => {
    handle = setupTestDb();
    const db = handle.db;
    seedPage(db, { page_id: 'bitcoin', title: 'Bitcoin' });
    seedPage(db, { page_id: 'pow', title: 'Proof of work', page_type: 'concept' });
    seedPage(db, { page_id: 'satoshi', title: 'Satoshi Nakamoto' });
    setBody('bitcoin', 'Bitcoin uses [[Proof of work]].');
    insertPageLink('bitcoin', 'pow', 'wikilink');
    insertPageLink('bitcoin', 'bitcoin', 'wikilink');
    insertPageLink('satoshi', 'bitcoin', 'wikilink');

    const { body } = await pageData('bitcoin');
    expect(body.links).toEqual([{ page_id: 'pow', title: 'Proof of work' }]);
    expect(body.backlinks).toEqual([{ page_id: 'satoshi', title: 'Satoshi Nakamoto' }]);
  });

  it('adds the connections card next to the unchanged links and backlinks', async () => {
    handle = setupTestDb();
    const db = handle.db;
    const paper = seedSource(db, { source_id: 'src-paper', title: 'Bitcoin paper' });
    seedPage(db, { page_id: 'bitcoin', title: 'Bitcoin' });
    seedPage(db, { page_id: 'pow', title: 'Proof of work', page_type: 'concept' });
    seedPage(db, { page_id: 'satoshi', title: 'Satoshi Nakamoto' });
    insertPageLink('bitcoin', 'pow', 'wikilink');
    insertPageLink('satoshi', 'bitcoin', 'wikilink');
    db.prepare(
      `INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id, description)
       VALUES ('Bitcoin', 'Proof of work', 'uses', ?, 'Bitcoin uses proof of work.')`
    ).run(paper);

    const { body } = await pageData('bitcoin');
    expect(body.connections).toEqual({
      groups: [
        {
          label: 'Uses',
          items: [
            {
              page_id: 'pow',
              title: 'Proof of work',
              type: 'uses',
              direction: 'out',
              source_count: 1,
              direction_dispute: null,
              outdated: null,
              evidence: [
                { source_id: paper, source_title: 'Bitcoin paper', source_archived: false, sentence: 'Bitcoin uses proof of work.', quote: null },
              ],
            },
          ],
        },
      ],
      linked_only: [{ page_id: 'satoshi', title: 'Satoshi Nakamoto' }],
    });
    expect(body.links).toEqual([{ page_id: 'pow', title: 'Proof of work' }]);
    expect(body.backlinks).toEqual([{ page_id: 'satoshi', title: 'Satoshi Nakamoto' }]);
  });

  it('answers 404 for an unknown page', async () => {
    handle = setupTestDb();
    expect((await pageData('missing')).status).toBe(404);
  });
});
