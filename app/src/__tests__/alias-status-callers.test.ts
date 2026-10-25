/**
 * getAliases() returns active aliases only (schema v29). GitNexus rates it
 * CRITICAL: five compile steps read it. Each test runs one caller with the
 * same alias stored as 'active' (the control: the alias is used) and as
 * 'suspended' (it must bind nothing):
 *   - resolve: the stored aliases Layer 1 binds through
 *   - extract: mention pinning
 *   - draft: the dossier's alias-aware extraction filter
 *   - crossref and page update (redraft): wikilink surfaces
 * The resolve route also records how each new alias was made.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as resolvePOST } from '../app/api/compile/resolve/route';
import { POST as extractPOST } from '../app/api/compile/extract/route';
import { POST as draftPOST } from '../app/api/compile/draft/route';
import { POST as crossrefPOST } from '../app/api/compile/crossref/route';
import { redraftPage } from '../lib/redraft';
import { DATA_ROOT, getAllAliases } from '../lib/db';
import {
  setupTestDb,
  seedSource,
  seedExtraction,
  seedPage,
  seedPagePlan,
  seedProvenance,
  seedCompileProgress,
  type TestDbHandle,
} from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

const STATUSES = ['active', 'suspended'] as const;
type Status = (typeof STATUSES)[number];

function storeAlias(alias: string, canonical: string, status: Status): void {
  handle!.db
    .prepare('INSERT INTO aliases (alias, canonical_name, status) VALUES (?, ?, ?)')
    .run(alias, canonical, status);
}

function post(handler: (r: Request) => Promise<Response>, route: string, body: Record<string, unknown>): Promise<Response> {
  return handler(
    new Request(`http://test${route}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    })
  );
}

/** fetch stub: url suffix -> JSON reply; records each request body. */
function stubNlp(replies: Record<string, (body: Record<string, unknown>) => unknown>): Array<{ url: string; body: Record<string, unknown> }> {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ url, body });
      const suffix = Object.keys(replies).find((s) => url.endsWith(s));
      if (!suffix) return new Response('not found', { status: 404 });
      return Response.json(replies[suffix](body));
    })
  );
  return calls;
}

describe('resolve', () => {
  async function runResolve(status: Status) {
    handle = setupTestDb();
    storeAlias('Ethereum', 'Ethereum Foundation', status);
    const session_id = 'sess-resolve';
    const sid = seedSource(handle.db, { onboarding_session_id: session_id, compile_status: 'extracted' });
    seedExtraction(handle.db, {
      source_id: sid,
      llm_output: {
        entities: [
          { name: 'GPT 4', type: 'PRODUCT', context: 'a model' },
          { name: 'GPT-4', type: 'PRODUCT', context: 'a model' },
          { name: 'Bitcoin network', type: 'PRODUCT', context: 'a chain' },
          { name: 'Bitcoin', type: 'PRODUCT', context: 'a chain' },
        ],
        concepts: [],
        relationships: [],
      },
    });
    const calls = stubNlp({
      '/resolve/fuzzy': () => ({
        resolved: [{ canonical: 'GPT-4', type: 'PRODUCT', aliases: ['GPT 4'], source_ids: [sid], method: 'skeleton' }],
        unresolved: [
          { name: 'Bitcoin network', type: 'PRODUCT', source_id: sid, context: 'a chain' },
          { name: 'Bitcoin', type: 'PRODUCT', source_id: sid, context: 'a chain' },
        ],
      }),
      '/resolve/embedding': () => ({
        resolved: [
          { canonical: 'GPT-4', type: 'PRODUCT', aliases: ['GPT 4'], source_ids: [sid], method: 'skeleton' },
          { canonical: 'Bitcoin', type: 'PRODUCT', aliases: ['Bitcoin network'], source_ids: [sid], method: 'embedding' },
        ],
        ambiguous: [],
        unresolved: [],
      }),
    });
    const res = await post(resolvePOST, '/api/compile/resolve', { session_id });
    expect(res.status).toBe(200);
    const fuzzy = calls.find((c) => c.url.endsWith('/resolve/fuzzy'))!.body;
    return { existing: fuzzy.existing_aliases as Array<{ alias: string; canonical: string }> };
  }

  it.each(STATUSES)('Layer 1 binds through the stored alias only when it is active (%s)', async (status) => {
    const { existing } = await runResolve(status);
    expect(existing).toEqual(status === 'active' ? [{ alias: 'Ethereum', canonical: 'Ethereum Foundation' }] : []);
  });

  it('records the method and session of each new alias', async () => {
    await runResolve('active');
    const made = getAllAliases().filter((a) => a.alias !== 'Ethereum');
    expect(made.map((a) => [a.alias, a.canonical_name, a.method, a.score, a.session_id, a.status])).toEqual([
      ['GPT 4', 'GPT-4', 'skeleton', null, 'sess-resolve', 'active'],
      ['Bitcoin network', 'Bitcoin', 'embedding', null, 'sess-resolve', 'active'],
    ]);
  });
});

describe('extract', () => {
  /** Runs the extract route on one source whose LLM output names `entities`; returns its mention and relation rows. */
  async function runExtract(entities: string[], relation?: [string, string]) {
    const sid = seedSource(handle!.db, { raw_markdown: 'Ethereum is a blockchain run by many people.' });
    stubNlp({
      '/extract/ner': () => ({ source_id: sid, entities: [], entity_count: 0, entity_density: 'low' }),
      '/extract/route': () => ({ profile: 'default', methods: [], skip: [] }),
      '/pipeline/extract-llm': () => ({
        entities: entities.map((name) => ({ name, type: 'ORG' })),
        concepts: [],
        claims: [],
        relationships: relation ? [{ from_entity: relation[0], to: relation[1], type: 'uses', description: 'x' }] : [],
      }),
    });
    const res = await post(extractPOST, '/api/compile/extract', { source_id: sid });
    expect(res.status).toBe(200);
    const names = handle!.db
      .prepare('SELECT canonical_name FROM entity_mentions WHERE source_id = ? ORDER BY canonical_name')
      .all(sid)
      .map((r) => (r as { canonical_name: string }).canonical_name);
    const relations = handle!.db
      .prepare('SELECT from_canonical, to_canonical FROM relationship_mentions WHERE source_id = ?')
      .all(sid)
      .map((r) => [(r as { from_canonical: string }).from_canonical, (r as { to_canonical: string }).to_canonical]);
    return { names, relations };
  }

  it.each(STATUSES)('pins a mention through the alias only when it is active (%s)', async (status) => {
    handle = setupTestDb();
    storeAlias('Ethereum', 'Ethereum Foundation', status);
    const { names } = await runExtract(['Ethereum']);
    expect(names).toEqual([status === 'active' ? 'Ethereum Foundation' : 'Ethereum']);
  });

  it('pins an exact page title before any alias, in mentions and relations', async () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'eth', title: 'Ethereum', page_type: 'entity' });
    seedPage(handle.db, { page_id: 'sol', title: 'Solidity', page_type: 'concept' });
    storeAlias('Ethereum', 'Ethereum Foundation', 'active');
    storeAlias('ETH', 'Ethereum Foundation', 'active');
    const { names, relations } = await runExtract(['ethereum', 'ETH'], ['ethereum', 'solidity']);
    // "ethereum" is the Ethereum page's title; "ETH" names no page, so its alias still applies.
    expect(names).toEqual(['Ethereum', 'Ethereum Foundation']);
    expect(relations).toEqual([['Ethereum', 'Solidity']]);
  });
});

describe('draft', () => {
  it.each(STATUSES)("puts a source naming the alias in the canonical's dossier only when it is active (%s)", async (status) => {
    handle = setupTestDb();
    storeAlias('Ethereum', 'Ethereum Foundation', status);
    const session_id = 'sess-draft';
    seedCompileProgress(handle.db, session_id);
    const sid = seedSource(handle.db, {
      onboarding_session_id: session_id,
      raw_markdown: 'Ethereum is a blockchain. The Ethereum Foundation funds research.',
    });
    seedExtraction(handle.db, {
      source_id: sid,
      llm_output: {
        entities: [{ name: 'Ethereum', type: 'ORG', context: 'ALIAS-ONLY-CONTEXT' }],
        concepts: [],
        relationships: [],
      },
    });
    seedPagePlan(handle.db, {
      session_id,
      title: 'Ethereum Foundation',
      page_type: 'entity',
      source_ids: [sid],
      draft_status: 'planned',
    });
    const calls = stubNlp({ '/pipeline/draft-page': () => ({ markdown: '---\ntitle: Ethereum Foundation\n---\n\nText.\n' }) });
    const res = await post(draftPOST, '/api/compile/draft', { session_id });
    expect(res.status).toBe(200);
    const body = calls.find((c) => c.url.endsWith('/pipeline/draft-page'))!.body;
    if (status === 'active') expect(body.extraction_dossier).toContain('ALIAS-ONLY-CONTEXT');
    else expect(body.extraction_dossier).not.toContain('ALIAS-ONLY-CONTEXT');
  });
});

describe('crossref', () => {
  it.each(STATUSES)('links the alias to its page only when it is active (%s)', async (status) => {
    handle = setupTestDb();
    storeAlias('Satoshi', 'Satoshi Nakamoto', status);
    const session_id = 'sess-crossref';
    seedCompileProgress(handle.db, session_id);
    const sid = seedSource(handle.db, {
      onboarding_session_id: session_id,
      raw_markdown: 'Satoshi designed proof-of-work for Bitcoin.',
    });
    seedPage(handle.db, { page_id: 'sn-page', title: 'Satoshi Nakamoto', page_type: 'entity' });
    const plan = seedPagePlan(handle.db, {
      session_id,
      title: 'Proof-of-work',
      page_type: 'concept',
      source_ids: [sid],
      draft_status: 'drafted',
      draft_content: '---\ntitle: Proof-of-work\n---\n\nSatoshi designed proof-of-work.\n',
    });
    stubNlp({});
    const res = await post(crossrefPOST, '/api/compile/crossref', { session_id });
    expect(res.status).toBe(200);
    const { draft_content } = handle.db.prepare('SELECT draft_content FROM page_plans WHERE plan_id = ?').get(plan) as {
      draft_content: string;
    };
    if (status === 'active') expect(draft_content).toContain('[[Satoshi Nakamoto|Satoshi]]');
    else expect(draft_content).not.toContain('[[');
  });
});

describe('page update (redraft)', () => {
  it.each(STATUSES)('links the alias to its page only when it is active (%s)', async (status) => {
    handle = setupTestDb();
    storeAlias('Satoshi', 'Satoshi Nakamoto', status);
    handle.db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('min_draft_chars', '10')").run();
    const sid = seedSource(handle.db, { title: 'Bitcoin Basics', raw_markdown: 'Satoshi designed proof-of-work for Bitcoin.' });
    const pageId = seedPage(handle.db, { page_id: 'pow-page', title: 'Proof-of-work', page_type: 'concept', summary: 'Old.' });
    seedPage(handle.db, { page_id: 'sn-page', title: 'Satoshi Nakamoto', page_type: 'entity' });
    seedProvenance(handle.db, pageId, sid);
    const file = path.join(DATA_ROOT, 'pages', `${pageId}.md.gz`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, zlib.gzipSync(Buffer.from('---\ntitle: Proof-of-work\n---\n\nOld body.\n')));

    const writes: string[] = [];
    stubNlp({
      '/pipeline/draft-page': () => ({
        markdown: '---\ntitle: Proof-of-work\npage_type: concept\nsummary: New.\n---\n\nSatoshi designed proof-of-work [S1].\n',
      }),
      '/storage/write-page': (body) => {
        writes.push(String(body.markdown));
        return { current_path: `/data/pages/${pageId}.md.gz`, previous_path: null };
      },
      '/vectors/upsert': () => ({ ok: true }),
    });
    await redraftPage(pageId);
    expect(writes).toHaveLength(1);
    if (status === 'active') expect(writes[0]).toContain('[[Satoshi Nakamoto|Satoshi]]');
    else expect(writes[0]).not.toContain('[[');
  });
});
