/**
 * The MCP server's contract with the app routes it reads. The fixture
 * mcp-server/test/contract/app-responses.json holds one response per route
 * with the fields the MCP tools read; the MCP tests check it against
 * mcp-server/src/types.ts and run every tool on it. Here each real route,
 * on a seeded wiki, must answer with at least that shape (same keys, same
 * JSON types), so renaming or dropping a field the tools read fails here
 * instead of silently in an agent's answer.
 */

import { randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/trigger-n8n', () => ({
  triggerSessionCompile: vi.fn(async () => ({ ok: true })),
}));

import { POST as agentSources } from '../app/api/agent/sources/route';
import { GET as search } from '../app/api/pages/search/route';
import { GET as sourceContent } from '../app/api/sources/[source_id]/content/route';
import { GET as sourceList } from '../app/api/sources/route';
import { GET as pageData } from '../app/api/wiki/[page_id]/data/route';
import { GET as related } from '../app/api/wiki/[page_id]/related/route';
import { GET as changes } from '../app/api/wiki/changes/route';
import { GET as wikiIndex } from '../app/api/wiki/index/route';
import { GET as research } from '../app/api/wiki/research/route';
import { GET as wikiStatus } from '../app/api/wiki/status/route';
import {
  DATA_ROOT,
  insertPageLink,
  logActivity,
  setAgentAddSourcesEnabled,
  setLastLintAt,
  setRelatedPagesMinSources,
} from '../lib/db';
import { syncPageTextDisagreements } from '../lib/disagreements';
import { seedExtraction, seedPage, seedProvenance, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

const CONTRACT_DIR = path.resolve(__dirname, '../../../mcp-server/test/contract');

interface Entry {
  route: string;
  body: unknown;
}
type CompareShape = (expected: unknown, actual: unknown) => { errors: string[]; unverified: string[] };

const contract = JSON.parse(readFileSync(path.join(CONTRACT_DIR, 'app-responses.json'), 'utf-8')) as Record<string, Entry>;
let compareShape: CompareShape;
let handle: TestDbHandle;
let ids: { paper: string; blog: string };

const json = async (res: Response) => ({ status: res.status, body: (await res.json()) as unknown });
const get = (url: string) => new Request(`http://test${url}`);
const params = <K extends string>(key: K, value: string) => ({ params: Promise.resolve({ [key]: value } as Record<K, string>) });

/** Each contract entry, answered by the real route on the seeded wiki, in this order. */
const CALLS: Record<string, () => Promise<{ status: number; body: unknown }>> = {
  // First, so wiki_status then reports the compile it queued.
  add_source: async () =>
    json(
      await agentSources(
        new Request('http://test/api/agent/sources', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            urls: ['https://example.org/new', 'https://bitcoin.org/bitcoin.pdf', 'https://x.com/someone/status/1'],
            client: 'contract',
          }),
        })
      )
    ),
  page_data: async () => json(await pageData(get('/api/wiki/btc/data'), params('page_id', 'btc'))),
  related: async () => json(await related(get('/api/wiki/btc/related'), params('page_id', 'btc'))),
  research: async () => json(await research(get('/api/wiki/research?topic=bitcoin'))),
  search: async () => json(await search(get('/api/pages/search?q=bitcoin&mode=hybrid&limit=10'))),
  wiki_index: async () => json(await wikiIndex(get('/api/wiki/index'))),
  source_text: async () => json(await sourceContent(get(`/api/sources/${ids.paper}/content`), params('source_id', ids.paper))),
  source_passages: async () =>
    json(await sourceContent(get(`/api/sources/${ids.paper}/content?q=mining`), params('source_id', ids.paper))),
  source_list: async () => json(await sourceList(get('/api/sources?limit=20'))),
  status: async () => json(await wikiStatus()),
  changes_since: async () => json(await changes(get('/api/wiki/changes?days=7'))),
  changes_session: async () => json(await changes(get('/api/wiki/changes?session_id=s1'))),
  changes_page: async () => json(await changes(get('/api/wiki/changes?page_id=btc'))),
};

/** Paths the seeded wiki leaves empty, so their items can't be checked here. */
const UNVERIFIED = ['$.bridges'];

beforeAll(async () => {
  compareShape = ((await import(/* @vite-ignore */ pathToFileURL(path.join(CONTRACT_DIR, 'json-shape.mjs')).href)) as {
    compareShape: CompareShape;
  }).compareShape;
  handle = setupTestDb();
  ids = seedWiki(handle);
  // The vector search behind hybrid search and related pages.
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => Response.json({ matches: [{ page_id: 'pow', similarity: 0.9 }, { page_id: 'btc', similarity: 0.8 }] }))
  );
});

afterAll(() => {
  vi.unstubAllGlobals();
  handle.cleanup();
});

describe('MCP contract with the app routes', () => {
  it('has a call for every contract entry', () => {
    expect(Object.keys(CALLS).sort()).toEqual(Object.keys(contract).filter((k) => !k.startsWith('_')).sort());
  });

  for (const name of Object.keys(CALLS)) {
    it(`${name}: the route answers with every field the MCP tools read`, async () => {
      const { status, body } = await CALLS[name]();
      expect(status, JSON.stringify(body)).toBe(200);
      const { errors, unverified } = compareShape(contract[name].body, body);
      expect(errors).toEqual([]);
      expect(unverified.filter((p) => !UNVERIFIED.includes(p))).toEqual([]);
    });
  }
});

function seedWiki(h: TestDbHandle): { paper: string; blog: string } {
  const db = h.db;
  const paper = seedSource(db, {
    source_id: randomUUID(),
    title: 'Bitcoin paper',
    source_type: 'url',
    source_url: 'https://bitcoin.org/bitcoin.pdf',
    onboarding_session_id: 's1',
    raw_markdown: '# Bitcoin\n\nA peer-to-peer electronic cash system.\n\n## Mining\n\nMining secures the network.',
  });
  const blog = seedSource(db, { source_id: randomUUID(), title: 'Mining blog', source_url: 'https://blog.test/mining' });
  const page = (id: string, title: string, type: string, body: string, sources: string[]) => {
    seedPage(db, { page_id: id, title, page_type: type, category: 'Cryptocurrency', summary: `${title} in brief.` });
    db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?').run(body, id);
    db.prepare('INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)').run(id, title, body);
    for (const s of sources) seedProvenance(db, id, s);
  };
  const btc = [
    `Bitcoin is digital cash [^${paper}]. Bitcoin mining uses [[Proof of work]] [^${blog}].`,
    `## Disputed: Launch date\n\nThe paper says 2008 [^${paper}]; the blog says 2009 [^${blog}].`,
  ].join('\n\n');
  page('btc', 'Bitcoin', 'entity', btc, [paper, blog]);
  page('pow', 'Proof of work', 'concept', `Proof of work secures bitcoin [^${blog}].`, [blog]);
  page('sat', 'Satoshi Nakamoto', 'entity', `Satoshi wrote the bitcoin paper [^${paper}].`, [paper]);
  page('ln', 'Lightning Network', 'concept', `Payments on top of bitcoin [^${blog}].`, [blog]);
  page('bch', 'Bitcoin Cash', 'entity', `A bitcoin fork [^${blog}].`, [blog]);
  page('etf', 'Bitcoin ETF', 'concept', `A fund holding bitcoin [^${paper}].`, [paper]);
  insertPageLink('btc', 'pow', 'wikilink');
  insertPageLink('btc', 'ln', 'wikilink');
  insertPageLink('sat', 'btc', 'wikilink');
  insertPageLink('bch', 'btc', 'wikilink');
  // The page's previous version, for recent_changes' section comparison.
  const previous = path.join(DATA_ROOT, 'pages', 'btc.20261001-120000.md.gz');
  mkdirSync(path.dirname(previous), { recursive: true });
  writeFileSync(previous, gzipSync('Intro.\n\n## History\n\nOld.'));
  db.prepare('UPDATE pages SET previous_content_path = ? WHERE page_id = ?').run(previous, 'btc');
  const old = seedSource(db, { title: 'Old note' });
  db.prepare(`UPDATE sources SET date_ingested = datetime('now', '-400 days') WHERE source_id = ?`).run(old);

  const rel = db.prepare(
    `INSERT INTO relationship_mentions
       (from_canonical, to_canonical, relationship_type, source_id, description, quote, quote_verified, first_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))`
  );
  rel.run('Bitcoin', 'Proof of work', 'uses', paper, 'Bitcoin uses proof of work.', 'Bitcoin relies on proof of work.', 1);
  rel.run('Bitcoin', 'Proof of work', 'uses', blog, null, null, null);
  rel.run('Bitcoin', 'Satoshi Nakamoto', 'created_by', paper, 'Satoshi Nakamoto created Bitcoin.', null, null);

  // A name several sources mention with no page yet.
  for (let i = 0; i < 3; i++) {
    const source_id = seedSource(db, { title: `Mention ${i}` });
    seedExtraction(db, { source_id, llm_output: { entities: [{ name: 'Bitcoin Core', type: 'PRODUCT' }] } });
  }

  db.prepare(
    `INSERT INTO compile_progress (session_id, status, steps, started_at) VALUES ('s1', 'completed', '{}', datetime('now', '-1 minute'))`
  ).run();
  db.prepare(
    `INSERT INTO collect_staging (stage_id, session_id, connector, payload, status, error_message) VALUES ('st1', 's1', 'url', ?, 'failed', 'Could not fetch the page')`
  ).run(JSON.stringify({ url: 'https://bad.test/' }));
  db.prepare(
    `INSERT INTO ingest_failures (failure_id, source_url, title_hint, error) VALUES ('f1', 'https://bad.test/', 'Bad page', 'dns')`
  ).run();
  // The page's Disputed section in the disagreements record (as its commit
  // writes it), plus the feed event recent_changes(page_id) lists.
  syncPageTextDisagreements(db, { page_id: 'btc', title: 'Bitcoin' }, btc, { log: false });
  logActivity('page_dispute_recorded', { source_id: null, details: { page_id: 'btc', title: 'Bitcoin', topic: 'launch date' } });
  logActivity('ingest_url_failed', { source_id: null, details: { url: 'https://bad.test/', error: 'dns', session_id: 's1' } });
  logActivity('lint_complete', {
    source_id: null,
    details: { contradictions: [{ page_a_id: 'btc', page_a_title: 'Bitcoin', page_b_id: 'sat', page_b_title: 'Satoshi Nakamoto', claim: 'Launch year' }] },
  });
  setLastLintAt(new Date().toISOString());
  setRelatedPagesMinSources(0);
  setAgentAddSourcesEnabled(true);
  return { paper, blog };
}
