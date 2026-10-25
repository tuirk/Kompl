/**
 * The contract fixture (test/contract/app-responses.json) against the MCP
 * side: each body must type-check as the response the tools read (every
 * field present, even those only older apps leave out), and every tool must
 * turn it into a full answer. The app's own contract test
 * (app/src/__tests__/mcp-contract.test.ts) holds the real routes to the
 * same fixture, so a field renamed on either side fails a test.
 */

import { describe, expect, it } from 'vitest';
import contract from './contract/app-responses.json' with { type: 'json' };
import type {
  AddSourceAnswer,
  Changes,
  PageData,
  PageMeta,
  RelatedPages,
  ResearchPack,
  SourceContent,
  SourceList,
  WikiIndex,
  WikiStatus,
} from '../src/types.js';
import { call, connect, fakeKompl, json } from './helpers.js';

/**
 * T with every field required (old-app fallbacks included: the current app
 * sends them all) and string unions widened, since JSON reads 'out' as string.
 */
type Full<T> = T extends string
  ? string
  : T extends readonly (infer U)[]
    ? Full<U>[]
    : T extends object
      ? { [K in keyof T]-?: Full<Exclude<T[K], undefined>> }
      : T;

// Compile-time: a field the tools read that the fixture lacks (or types
// differently) fails `npm test` (tsc -p tsconfig.test.json).
const bodies = {
  add_source: contract.add_source.body satisfies Full<AddSourceAnswer>,
  page_data: contract.page_data.body satisfies Full<PageData>,
  related: contract.related.body satisfies Full<RelatedPages>,
  research: contract.research.body satisfies Full<ResearchPack>,
  search: contract.search.body satisfies Full<{ items: PageMeta[]; count: number; degraded: boolean }>,
  wiki_index: contract.wiki_index.body satisfies Full<WikiIndex>,
  source_text: contract.source_text.body satisfies Full<Omit<SourceContent, 'query' | 'passages'>>,
  source_passages: contract.source_passages.body satisfies Full<Omit<SourceContent, 'offset' | 'text' | 'next_offset'>>,
  source_list: contract.source_list.body satisfies Full<SourceList>,
  status: contract.status.body satisfies Full<WikiStatus>,
  changes_since: contract.changes_since.body satisfies Full<Extract<Changes, { mode: 'since' }>>,
  changes_session: contract.changes_session.body satisfies Full<Extract<Changes, { mode: 'session' }>>,
  changes_page: contract.changes_page.body satisfies Full<Extract<Changes, { mode: 'page' }>>,
};

/** The fixture's entries ("_about" is a note). */
const ENTRIES = (Object.entries(contract) as Array<[string, unknown]>).filter(
  (e): e is [keyof typeof bodies, { route: string; body: unknown }] => typeof e[1] === 'object'
);

/** A fake app answering every route from the fixture. */
function app() {
  const routes: Record<string, unknown> = {};
  for (const [name, entry] of ENTRIES) routes[entry.route] = bodies[name];
  routes[contract.changes_since.route] = (url: URL) =>
    json(url.searchParams.has('page_id') ? bodies.changes_page : url.searchParams.has('session_id') ? bodies.changes_session : bodies.changes_since);
  routes[contract.source_text.route] = (url: URL) => json(url.searchParams.has('q') ? bodies.source_passages : bodies.source_text);
  return fakeKompl(routes);
}

/** Signs that a tool printed a field the app no longer sends, or under another name. */
const BROKEN = /undefined|NaN|\[object Object\]/;

describe('MCP contract fixture', () => {
  it('type-checks every entry and names its route', () => {
    expect(ENTRIES.map(([name]) => name).sort()).toEqual(Object.keys(bodies).sort());
    for (const [name, entry] of ENTRIES) expect(entry.route.startsWith('/api/'), name).toBe(true);
  });

  it.each([
    ['read_page', { page_id: 'btc', include_related: true }, ['# Bitcoin', '[1] Bitcoin paper', 'source_id `src-paper`', '- Uses: Proof of work (`pow`)', 'Lightning Network', '**Related:** Proof of work', '- Disputed: Launch date · [1]', 'Quotes: "The paper says 2008."']],
    ['read_source', { source_id: 'src-paper' }, ['# Bitcoin paper', 'Characters 1–89 of 89', 'offset=89']],
    ['read_source', { page_id: 'btc', n: 1, query: 'mining' }, ['Source [1] of "Bitcoin"', 'Passages matching "mining"', 'Mining secures the network.']],
    ['research_topic', { topic: 'bitcoin' }, ['## 1. Bitcoin', 'Disputed here: Launch date', '- Bitcoin uses Proof of work', '[1] Bitcoin paper', 'source_id `src-paper`', 'Bitcoin Core (3)', 'Lightning Network']],
    ['search_wiki', { query: 'bitcoin' }, ['**Bitcoin** (entity) [Cryptocurrency]', 'ID: `btc`']],
    ['search_wiki', {}, ['**Bitcoin** (entity) [Cryptocurrency] — 2 source(s)']],
    ['list_sources', {}, ['**Bitcoin paper**', 'in 2 page(s)', 'ID: `src-paper`']],
    ['wiki_status', {}, ['Bitcoin Core', 'Bitcoin ETF', 'Old note', 'Launch year', 'Cryptocurrency']],
    ['recent_changes', { days: 7 }, ['Bitcoin paper', 'disputed, Bitcoin (Launch date), not yet confirmed by the user', 'dns']],
    ['recent_changes', { session_id: 's1' }, ['`s1`', 'https://bad.test/: failed']],
    ['recent_changes', { page_id: 'btc' }, ['Bitcoin', 'History', 'Disputed: Launch date']],
    ['add_source', { urls: ['https://example.org/new'] }, ['Added 1 source(s)', 'src-paper', 'https://x.com/someone/status/1']],
  ])('%s %j reads every field it shows', async (tool, args, expected) => {
    const res = await call(await connect(app().fetchImpl), tool, args);
    expect(res.isError, res.text).toBe(false);
    expect(res.text).not.toMatch(BROKEN);
    for (const piece of expected) expect(res.text).toContain(piece);
  });
});
