/**
 * research_topic's pack (lib/research.ts, GET /api/wiki/research): pages
 * found by hybrid search, each with the cited sentences that best match the
 * topic, ONE source list numbered across all pages (a source shared by two
 * pages gets one number, every [n] resolves), the disputes pages record,
 * the thin-page flag, and names with no page that the topic touches.
 */

import { randomUUID } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../app/api/wiki/research/route';
import { scanCitations } from '../lib/citations';
import { placeholdersToSharedText } from '../lib/cited-text';
import { keyLines } from '../lib/research';
import { seedExtraction, seedPage, seedProvenance, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

function stubVectors() {
  const fetchMock = vi.fn(async (url: string | URL) =>
    String(url).endsWith('/vectors/search') ? Response.json({ matches: [] }) : new Response('unexpected', { status: 599 })
  );
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

function page(id: string, title: string, body: string, sources: string[], page_type = 'concept') {
  const db = handle!.db;
  seedPage(db, { page_id: id, title, page_type, summary: `${title} summary.` });
  db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?').run(body, id);
  db.prepare('INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)').run(id, title, body);
  for (const s of sources) seedProvenance(db, id, s);
}

async function research(query: string) {
  const res = await GET(new Request(`http://test/api/wiki/research?${query}`));
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

describe('research pack', () => {
  it('says which recorded disagreements are changes over time (plan 3.1)', async () => {
    handle = setupTestDb();
    const a = seedSource(handle.db, { source_id: randomUUID(), title: 'Old report' });
    const b = seedSource(handle.db, { source_id: randomUUID(), title: 'New report' });
    page(
      'reward',
      'Block reward',
      [
        `The block reward pays miners [^${a}].`,
        '### Changed: reward size',
        `50 coins as of 2009 [^${a}]; 3.125 coins as of 2024 [^${b}].`,
        '### Disputed: first halving date',
        `2012 [^${a}] or 2013 [^${b}].`,
      ].join('\n\n'),
      [a, b]
    );
    stubVectors();
    const { body } = await research('topic=block%20reward');
    const reward = body.pages.find((p: { page_id: string }) => p.page_id === 'reward');
    expect(reward.disputes).toEqual(['Reward size (changed over time)', 'First halving date']);
  });

  it('numbers sources once across pages and keeps only the cited lines about the topic', async () => {
    handle = setupTestDb();
    const db = handle.db;
    const paper = seedSource(db, { source_id: randomUUID(), title: 'Bitcoin paper', source_url: 'https://bitcoin.org/bitcoin.pdf' });
    const blog = seedSource(db, { source_id: randomUUID(), title: 'Mining blog' });
    page(
      'pow',
      'Proof of work',
      [
        `Proof of work secures bitcoin through mining [^${paper}].`,
        `It was first described in 1993 [^${blog}].`,
        '## Key facts',
        `- Mining uses a lot of energy [^${blog}].`,
        'An uncited sentence about mining.',
        '## Disputed: energy figures',
        `Estimates of mining energy differ: low [^${paper}], high [^${blog}].`,
      ].join('\n\n'),
      [paper, blog]
    );
    page('btc', 'Bitcoin', `Bitcoin rewards mining with new coins [^${paper}].`, [paper], 'entity');
    const fetchMock = stubVectors();

    const { status, body } = await research('topic=bitcoin%20mining%20energy');
    expect(status).toBe(200);
    expect(body.detail).toBe('brief');
    const ids = body.pages.map((p: { page_id: string }) => p.page_id);
    expect(ids).toContain('pow');
    expect(ids).toContain('btc');

    const pow = body.pages.find((p: { page_id: string }) => p.page_id === 'pow');
    expect(pow.key_lines).toHaveLength(3);
    expect(pow.key_lines.join(' ')).not.toContain('1993');
    expect(pow.key_lines.join(' ')).not.toContain('uncited');
    expect(pow.disputes).toEqual(['Energy figures']);
    expect(pow.path).toBe('/wiki/pow');

    // One list for the whole pack: the paper keeps its number on both pages.
    const numbers = (lines: string[]) => [...lines.join(' ').matchAll(/\[(\d+)\]/g)].map((m) => Number(m[1]));
    const used = new Set([...body.pages.flatMap((p: { key_lines: string[] }) => numbers(p.key_lines))]);
    expect(body.sources.map((s: { n: number }) => s.n)).toEqual([...used].sort((a, b) => a - b));
    const paperN = body.sources.find((s: { source_id: string }) => s.source_id === paper).n;
    const btc = body.pages.find((p: { page_id: string }) => p.page_id === 'btc');
    expect(btc.key_lines[0]).toContain(`[${paperN}]`);
    expect(body.sources.find((s: { n: number }) => s.n === paperN)).toMatchObject({
      title: 'Bitcoin paper',
      source_url: 'https://bitcoin.org/bitcoin.pdf',
      path: `/source/${paper}`,
    });

    expect(fetchMock.mock.calls.every(([url]) => String(url).endsWith('/vectors/search'))).toBe(true);
  });

  it('flags pages resting on one source and lists names with no page that the topic touches', async () => {
    handle = setupTestDb();
    const db = handle.db;
    const only = seedSource(db, { source_id: randomUUID(), title: 'Only source' });
    page('thin', 'Danksharding plans', `Ethereum plans danksharding with Vitalik [^${only}].`, [only]);
    for (let i = 0; i < 3; i++) {
      const s = seedSource(db, { title: `Mention ${i}` });
      seedExtraction(db, { source_id: s, llm_output: { entities: [{ name: 'Vitalik', type: 'PERSON' }, { name: 'Catan', type: 'ORG' }] } });
    }
    stubVectors();

    const { body } = await research('topic=danksharding&detail=full');
    expect(body.detail).toBe('full');
    expect(body.pages[0]).toMatchObject({ page_id: 'thin', thin: true });
    expect(body.missing_pages).toEqual([{ name: 'Vitalik', mentions: 3 }]);
  });

  it('quotes source pages under their own source, quotes a repeated line once, and matches names as whole words', async () => {
    handle = setupTestDb();
    const db = handle.db;
    const note = seedSource(db, { source_id: randomUUID(), title: 'Mining note' });
    const paper = seedSource(db, { source_id: randomUUID(), title: 'Paper' });
    page('note', 'Mining note', 'Mining uses a lot of energy. Unrelated sentence here.', [note], 'original-source');
    page('pow', 'Proof of work', `Mining uses a lot of energy [^${paper}]. Miners compete [^${paper}].`, [paper]);
    db.prepare('UPDATE pages SET summary = ? WHERE page_id = ?').run('Uses [[Proof of work|PoW]] for mining.', 'note');
    for (let i = 0; i < 3; i++) {
      const s = seedSource(db, { title: `Mention ${i}` });
      seedExtraction(db, { source_id: s, llm_output: { entities: [{ name: 'AI', type: 'ORG' }] } });
    }
    page('said', 'Said page', 'He said mining again.', [paper]);
    stubVectors();

    const { body } = await research('topic=mining%20energy');
    const byId = Object.fromEntries(body.pages.map((p: { page_id: string }) => [p.page_id, p]));
    const noteN = body.sources.find((s: { source_id: string }) => s.source_id === note).n;
    expect(byId.note.key_lines[0]).toBe(`Mining uses a lot of energy[${noteN}].`);
    expect(byId.note.summary).toBe('Uses PoW for mining.');
    // Quoted on the note already: the concept page quotes its other line instead.
    expect(byId.pow.key_lines.join(' ')).not.toContain('energy');
    expect(body.missing_pages).toEqual([]);
  });

  it('asks for a topic', async () => {
    handle = setupTestDb();
    expect((await research('topic=%20')).status).toBe(400);
  });
});

describe('key lines', () => {
  it('skips headings and code, drops list markers and keeps page order', () => {
    const id = randomUUID();
    const scan = scanCitations(
      [`## Mining [^${id}]`, '```', `mining in code [^${id}]`, '```', `- Mining is costly [^${id}].`, `Energy use grows [^${id}].`].join('\n'),
      () => false
    );
    const lines = keyLines(scan.markdown, ['mining', 'energy'], 5).map((l) => placeholdersToSharedText(l, scan.order, []));
    expect(lines).toEqual(['Mining is costly[1].', 'Energy use grows[1].']);
  });
});
