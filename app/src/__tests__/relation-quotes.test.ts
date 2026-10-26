/**
 * Relation quotes (plan 3.2, schema v30 step): relationship_mentions.quote
 * and quote_verified, the source's sentence for a relation and the
 * nlp-service check of it against the source.
 *
 * Covers:
 *   - the columns exist (nullable) and migrate.py adds them behind a PRAGMA
 *     guard inside the v30 step and on the already-at-v30 path
 *   - the extract route's row builder carries them: trimmed and clipped,
 *     verified only true/false with a quote, a later verified quote
 *     replacing an unverified first one
 *   - insert, re-insert, the resolve rebuild and the competes_with re-sort
 *     keep a quote; export carries the columns and import restores them
 *     (an older backup without them imports NULL)
 *   - the read models show a quote only when verified, quoted evidence
 *     first; old rows keep Kompl's summary
 *   - the Connections card and the graph's evidence list say "Quoted from"
 *     for a quote and "Kompl's summary, from" for a summary
 *   - the extract route stores the nlp-service reply's quotes and checks in
 *     the extraction and the relation rows, and counts them in its
 *     extraction_complete event
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import JSZip from 'jszip';
import ConnectionsPanel from '../app/wiki/[page_id]/ConnectionsPanel';
import { EvidenceList } from '../app/wiki/graph/panel-parts';
import { POST as importPOST } from '../app/api/import/route';
import { POST as extractPOST } from '../app/api/compile/extract/route';
import { getAllRelationshipMentions, getExtraction, insertRelationshipMentions, rebuildSessionMentions } from '../lib/db';
import { extractionCheckCounts } from '../lib/extraction-checks';
import { sortDirectionAgnosticRelations } from '../lib/relation-order';
import { buildRelationRows, cleanRelationQuote, RELATION_QUOTE_MAX_CHARS } from '../lib/relation-rows';
import { getPageConnections, getRelationsAmong } from '../lib/relations';
import { seedPage, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

type Stored = { to: string; quote: string | null; quote_verified: number | null; description: string | null };

function stored(): Stored[] {
  return handle!.db
    .prepare(
      `SELECT to_canonical AS "to", quote, quote_verified, description
         FROM relationship_mentions ORDER BY source_id, to_canonical`
    )
    .all() as Stored[];
}

describe('schema', () => {
  it('relationship_mentions has nullable quote and quote_verified columns', () => {
    handle = setupTestDb();
    const cols = handle.db.prepare('PRAGMA table_info(relationship_mentions)').all() as Array<{
      name: string;
      notnull: number;
    }>;
    for (const name of ['quote', 'quote_verified']) {
      expect(cols.find((c) => c.name === name)?.notnull).toBe(0);
    }
  });

  it('migrate.py adds them in the v30 step and on the already-at-v30 path, with no new version', () => {
    const migrate = readFileSync(join(__dirname, '../../../scripts/migrate.py'), 'utf8');
    expect(/^SCHEMA_VERSION = (\d+)/m.exec(migrate)?.[1]).toBe('30');
    expect(migrate).toContain('ALTER TABLE relationship_mentions ADD COLUMN {ddl}');
    expect(migrate).toContain('("quote", "quote TEXT"), ("quote_verified", "quote_verified INTEGER")');
    // Called twice: in `if current < 30:` and on the early path.
    expect(migrate.match(/_ensure_relation_quotes\(conn\)/g)).toHaveLength(2);
  });
});

describe('buildRelationRows (extract route)', () => {
  const pin = (name: string) => name;

  it('carries the quote and its check; empty, odd or unchecked values read as null', () => {
    const long = `${'word '.repeat(150)}end.`;
    const rows = buildRelationRows(
      [
        { from_entity: 'Bitcoin', to: 'Proof of work', type: 'uses', description: 'd', quote: ' Bitcoin relies on proof of work. ', quote_verified: true },
        { from_entity: 'Bitcoin', to: 'Satoshi', type: 'created_by', description: 'd', quote: 'Made up.', quote_verified: false },
        { from_entity: 'Bitcoin', to: 'Ethereum', type: 'competes_with', description: 'd', quote: '  ', quote_verified: true },
        { from_entity: 'Bitcoin', to: 'Lightning', type: 'uses', description: 'd', quote: 42, quote_verified: true },
        { from_entity: 'Bitcoin', to: 'SHA-256', type: 'uses', description: 'd', quote: long, quote_verified: 'yes' },
        { from_entity: 'Bitcoin', to: 'Mempool', type: 'uses', description: 'd' },
      ],
      'src-1',
      pin
    );
    expect(rows.map((r) => [r.quote, r.quote_verified])).toEqual([
      ['Bitcoin relies on proof of work.', true],
      ['Made up.', false],
      [null, null],
      [null, null],
      [expect.stringMatching(/…$/), null],
      [null, null],
    ]);
    expect(rows[4].quote).toHaveLength(RELATION_QUOTE_MAX_CHARS);
  });

  it('a later verified quote replaces an unverified first one of the same row', () => {
    const rows = buildRelationRows(
      [
        { from_entity: 'A', to: 'B', type: 'uses', description: 'first', quote: 'Wrong words.', quote_verified: false },
        { from_entity: 'A', to: 'B', type: 'Uses', description: 'second', quote: 'A uses B.', quote_verified: true },
        { from_entity: 'A', to: 'B', type: 'uses', description: 'third', quote: 'Also true.', quote_verified: true },
      ],
      'src-1',
      pin
    );
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ description: 'first', quote: 'A uses B.', quote_verified: true });
  });

  it('cleanRelationQuote never keeps a check without a quote', () => {
    expect(cleanRelationQuote(null, true)).toEqual({ quote: null, quote_verified: null });
    expect(cleanRelationQuote('Q.', undefined)).toEqual({ quote: 'Q.', quote_verified: null });
  });
});

describe('storage', () => {
  const base = { from_canonical: 'Bitcoin', relationship_type: 'uses', source_id: '' };

  it('stores 1/0/NULL, and a re-insert without a quote keeps the stored one', () => {
    handle = setupTestDb();
    const src = seedSource(handle.db, { title: 'One' });
    insertRelationshipMentions([
      { ...base, source_id: src, to_canonical: 'A', description: 'd', quote: 'Q1.', quote_verified: true },
      { ...base, source_id: src, to_canonical: 'B', description: 'd', quote: 'Q2.', quote_verified: false },
      { ...base, source_id: src, to_canonical: 'C', description: 'd' },
    ]);
    insertRelationshipMentions([{ ...base, source_id: src, to_canonical: 'A', description: null }]);
    insertRelationshipMentions([{ ...base, source_id: src, to_canonical: 'B', description: null, quote: 'Q2 found.', quote_verified: true }]);
    expect(stored()).toEqual([
      { to: 'A', quote: 'Q1.', quote_verified: 1, description: 'd' },
      { to: 'B', quote: 'Q2 found.', quote_verified: 1, description: 'd' },
      { to: 'C', quote: null, quote_verified: null, description: 'd' },
    ]);
  });

  it('the resolve rebuild keeps a stored quote when the rebuilt row has none', () => {
    handle = setupTestDb();
    const src = seedSource(handle.db, { title: 'One', onboarding_session_id: 'sess' });
    insertRelationshipMentions([{ ...base, source_id: src, to_canonical: 'A', description: 'd', quote: 'Q1.', quote_verified: true }]);
    const row = (to: string, quote: string | null) => ({
      ...base,
      source_id: src,
      to_canonical: to,
      description: null,
      quote,
      quote_verified: quote === null ? null : true,
    });
    rebuildSessionMentions('sess', [{ source_id: src, entities: [], relations: [row('A', null), row('B', 'New quote.')] }]);
    expect(stored()).toEqual([
      { to: 'A', quote: 'Q1.', quote_verified: 1, description: 'd' },
      { to: 'B', quote: 'New quote.', quote_verified: 1, description: null },
    ]);
  });

  it('the competes_with re-sort keeps the quote of the row it collides with', () => {
    handle = setupTestDb();
    const src = seedSource(handle.db, { title: 'One' });
    const rel = handle.db.prepare(
      `INSERT INTO relationship_mentions
         (from_canonical, to_canonical, relationship_type, source_id, description, quote, quote_verified)
       VALUES (?, ?, 'competes_with', ?, ?, ?, ?)`
    );
    rel.run('Zcash', 'Bitcoin', src, null, null, null); // out of order, as an older resolve left it
    rel.run('Bitcoin', 'Zcash', src, 'They compete.', 'Zcash competes with Bitcoin.', 1);
    expect(sortDirectionAgnosticRelations(handle.db)).toBe(1);
    expect(
      handle.db.prepare('SELECT from_canonical AS f, to_canonical AS t, description, quote, quote_verified FROM relationship_mentions').all()
    ).toEqual([{ f: 'Bitcoin', t: 'Zcash', description: 'They compete.', quote: 'Zcash competes with Bitcoin.', quote_verified: 1 }]);
  });

  it('export carries the columns', () => {
    handle = setupTestDb();
    const src = seedSource(handle.db, { title: 'One' });
    insertRelationshipMentions([{ ...base, source_id: src, to_canonical: 'A', description: 'd', quote: 'Q1.', quote_verified: true }]);
    expect(getAllRelationshipMentions()[0]).toMatchObject({ quote: 'Q1.', quote_verified: 1 });
  });
});

describe('POST /api/import', () => {
  const SOURCE = {
    source_id: 'src-a',
    title: 'Bitcoin whitepaper',
    source_type: 'url',
    source_url: 'https://example.com/btc',
    content_hash: 'sha256-a',
    file_path: '/data/raw/src-a.md.gz',
    status: 'active',
    date_ingested: '2026-05-01 10:00:00',
    metadata: null,
  };
  const row = (to: string, extra: Record<string, unknown> = {}) => ({
    from_canonical: 'Bitcoin',
    to_canonical: to,
    relationship_type: 'uses',
    source_id: 'src-a',
    first_seen_at: '2026-05-01 10:00:00',
    description: 'd',
    ...extra,
  });

  async function importBundle(relations: Record<string, unknown>[]): Promise<Response> {
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ format: 'kompl', version: 1, schema_version: 30 }));
    zip.file('db/pages.json', '[]');
    zip.file('db/sources.json', JSON.stringify([SOURCE]));
    zip.file('db/extractions.json', '[]');
    zip.file('db/relationship_mentions.json', JSON.stringify(relations));
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const form = new FormData();
    form.set('file', new File([new Uint8Array(buf)], 'backup.kompl.zip'));
    return importPOST(new Request('http://test/api/import', { method: 'POST', body: form }));
  }

  it('restores quotes, and an older backup without them imports NULL', async () => {
    handle = setupTestDb();
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 200 })));
    const res = await importBundle([
      row('A', { quote: 'Bitcoin relies on A.', quote_verified: 1 }),
      row('B', { quote: 'Not in the source.', quote_verified: 0 }),
      row('C'),
      row('D', { quote: 'Odd check.', quote_verified: true }),
    ]);
    expect(res.status).toBe(200);
    expect(stored()).toEqual([
      { to: 'A', quote: 'Bitcoin relies on A.', quote_verified: 1, description: 'd' },
      { to: 'B', quote: 'Not in the source.', quote_verified: 0, description: 'd' },
      { to: 'C', quote: null, quote_verified: null, description: 'd' },
      { to: 'D', quote: 'Odd check.', quote_verified: null, description: 'd' },
    ]);
  });
});

describe('read models and the Connections card', () => {
  function seed() {
    handle = setupTestDb();
    const db = handle.db;
    const [old, unchecked, checked] = ['Old', 'Unchecked', 'Checked'].map((title) => seedSource(db, { title }));
    seedPage(db, { page_id: 'btc', title: 'Bitcoin' });
    seedPage(db, { page_id: 'pow', title: 'Proof of work' });
    const rel = db.prepare(
      `INSERT INTO relationship_mentions
         (from_canonical, to_canonical, relationship_type, source_id, description, quote, quote_verified, first_seen_at)
       VALUES ('Bitcoin', 'Proof of work', 'uses', ?, ?, ?, ?, ?)`
    );
    rel.run(old, 'Old summary.', null, null, '2026-01-01 00:00:00');
    rel.run(checked, 'Checked summary.', 'Bitcoin relies on proof of work.', 1, '2026-01-02 00:00:00');
    rel.run(unchecked, 'Unchecked summary.', 'Words the source never used.', 0, '2026-01-03 00:00:00');
    return { old, unchecked, checked };
  }

  it('gives a quote only when verified, quoted evidence first', () => {
    const { old, unchecked, checked } = seed();
    const [item] = getPageConnections('btc').groups[0].items;
    expect(item.evidence.map((e) => [e.source_id, e.quote, e.sentence])).toEqual([
      [checked, 'Bitcoin relies on proof of work.', 'Checked summary.'],
      [unchecked, null, 'Unchecked summary.'],
      [old, null, 'Old summary.'],
    ]);
  });

  it('research relations lead with the quoted source', () => {
    const { checked } = seed();
    const [relation] = getRelationsAmong(['btc'], 5);
    expect(relation.source_ids[0]).toBe(checked);
    expect(relation).toMatchObject({ quote: 'Bitcoin relies on proof of work.', sentence: 'Checked summary.' });
  });

  it('labels a quote as quoted and a summary as Kompl\'s', () => {
    seed();
    const html = renderToString(createElement(ConnectionsPanel, { pageId: 'btc', connections: getPageConnections('btc') }));
    expect(html).toContain('“Bitcoin relies on proof of work.”');
    expect(html).toMatch(/Quoted from <a [^>]*>Checked</);
    expect(html).toMatch(/Kompl(&#x27;|')s summary, from <a [^>]*>Unchecked</);
    expect(html).not.toContain('Words the source never used.');
  });

  it("the graph's evidence list labels them the same way", () => {
    seed();
    const [item] = getPageConnections('btc').groups[0].items;
    const html = renderToString(createElement(EvidenceList, { item, pageId: 'btc' }));
    expect(html).toContain('“Bitcoin relies on proof of work.”');
    expect(html).toMatch(/Quoted from <a [^>]*>Checked</);
    expect(html).toMatch(/Kompl(&#x27;|')s summary, from <a [^>]*>Old</);
  });
});

describe('POST /api/compile/extract', () => {
  const REPLY = {
    title: '',
    entities: [{ name: 'Ethereum', type: 'PRODUCT' }, { name: 'Solidity', type: 'PRODUCT' }],
    concepts: [],
    claims: [
      { claim: 'Ethereum runs contracts.', quote: 'Ethereum runs Solidity contracts.', quote_verified: true },
      { claim: 'Ethereum is fast.', quote: 'Ethereum is the fastest chain.', quote_verified: false },
      { claim: 'An old-style claim.' },
    ],
    relationships: [
      {
        from_entity: 'Ethereum', to: 'Solidity', type: 'uses', description: 'Ethereum runs Solidity.',
        quote: 'Ethereum runs Solidity contracts.', quote_verified: true, ends_listed: true,
      },
      { from_entity: 'Ethereum', to: 'EVM', type: 'uses', description: 'Runs on the EVM.', quote: null, quote_verified: null, ends_listed: false },
    ],
  };

  it('keeps the quotes and checks in the extraction and the rows, and counts them', async () => {
    handle = setupTestDb();
    const sid = seedSource(handle.db, { raw_markdown: 'Ethereum runs Solidity contracts.' });
    const replies: Record<string, unknown> = {
      '/extract/ner': { source_id: sid, entities: [], entity_count: 0, entity_density: 'low' },
      '/extract/route': { profile: 'default', methods: [], skip: [] },
      '/pipeline/extract-llm': REPLY,
    };
    vi.stubGlobal('fetch', vi.fn(async (input: RequestInfo | URL) => {
      const suffix = Object.keys(replies).find((k) => String(input).endsWith(k));
      return suffix ? Response.json(replies[suffix]) : new Response('not found', { status: 404 });
    }));
    const res = await extractPOST(new Request('http://test/api/compile/extract', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source_id: sid }),
    }));
    expect(res.status).toBe(200);

    const saved = JSON.parse(getExtraction(sid)!.llm_output);
    expect(saved.claims.map((c: { quote_verified?: boolean }) => c.quote_verified)).toEqual([true, false, undefined]);
    expect(stored()).toEqual([
      { to: 'EVM', quote: null, quote_verified: null, description: 'Runs on the EVM.' },
      { to: 'Solidity', quote: 'Ethereum runs Solidity contracts.', quote_verified: 1, description: 'Ethereum runs Solidity.' },
    ]);
    const event = handle.db
      .prepare(`SELECT details FROM activity_log WHERE action_type = 'extraction_complete'`)
      .get() as { details: string };
    expect(JSON.parse(event.details)).toMatchObject({
      claim_count: 3,
      claims_quoted: 2,
      claims_quote_verified: 1,
      relations_quoted: 1,
      relations_quote_verified: 1,
      relations_unlisted_end: 1,
    });
  });

  it('counts zero for an extraction made before the checks', () => {
    expect(extractionCheckCounts({ claims: [{ claim: 'c' }], relationships: [{ from_entity: 'a', to: 'b' }] })).toEqual({
      claims_quoted: 0,
      claims_quote_verified: 0,
      relations_quoted: 0,
      relations_quote_verified: 0,
      relations_unlisted_end: 0,
    });
    expect(extractionCheckCounts(null).claims_quoted).toBe(0);
  });
});
