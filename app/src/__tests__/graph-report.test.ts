/**
 * The knowledge graph part of GET /api/wiki/status (lib/graph-report.ts):
 * topic clusters and bridge pages as the map's default view shows them
 * (typed lines only, no source pages, "Uncategorized" no topic), the same
 * bridges as the map's badges, and the cache that spares repeated
 * wiki_status calls the betweenness pass.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { GET } from '../app/api/wiki/status/route';
import { archivePage, insertPageLink, setSourceStatus } from '../lib/db';
import { mapBridges } from '../lib/graph-bridges';
import { buildGraphModel } from '../lib/graph-model';
import { buildGraphReport, graphReportCached } from '../lib/graph-report';
import { getWikiGraph } from '../lib/wiki-graph';
import { seedPage, seedProvenance, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;
let source = '';

afterEach(() => {
  vi.restoreAllMocks();
  handle?.cleanup();
  handle = null;
});

function page(id: string, title: string, category: string | null, page_type = 'concept') {
  seedPage(handle!.db, { page_id: id, title, category, page_type });
  seedProvenance(handle!.db, id, source);
}

function rel(from: string, to: string, type = 'uses') {
  handle!.db
    .prepare('INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id) VALUES (?, ?, ?, ?)')
    .run(from, to, type, source);
}

/**
 * Crypto: BTC, ETH, PoW; AI: Claude, LLM; Travel: Vilnius. "Hub" (AI)
 * joins the three topics. Plus a source page, an uncategorized page, a
 * "related to"-only pair and a plain link, none of which count.
 */
function seedWiki() {
  handle = setupTestDb();
  source = seedSource(handle.db, { title: 'A source' });
  page('btc', 'BTC', 'Crypto');
  page('eth', 'ETH', 'Crypto');
  page('pow', 'PoW', 'Crypto');
  page('claude', 'Claude', 'AI');
  page('llm', 'LLM', 'AI');
  page('hub', 'Hub', 'AI');
  page('vilnius', 'Vilnius', 'Travel');
  page('loose', 'Loose page', null);
  page('summary', 'A summary', 'Crypto', 'source-summary');
  rel('BTC', 'PoW');
  rel('ETH', 'PoW');
  rel('Claude', 'LLM', 'part_of');
  rel('Hub', 'BTC');
  rel('Hub', 'Claude');
  rel('Hub', 'Vilnius');
  rel('Loose page', 'Vilnius');
  rel('A summary', 'BTC'); // source pages are hidden on the default view
  rel('ETH', 'BTC', 'related_to'); // "related to" lines are hidden too
  insertPageLink('llm', 'claude', 'wikilink');
  insertPageLink('eth', 'btc', 'wikilink');
}

describe('graph report', () => {
  it('counts each topic\'s pages and typed lines on the default view', () => {
    seedWiki();
    const report = buildGraphReport();
    expect(report.clusters).toEqual({
      count: 3,
      top: [
        { name: 'AI', pages: 3, connections: 2 },
        { name: 'Crypto', pages: 3, connections: 2 },
        { name: 'Travel', pages: 1, connections: 0 },
      ],
    });
  });

  it('names the map\'s bridge pages with the topics they join', () => {
    seedWiki();
    const { bridges } = buildGraphReport();
    expect(bridges[0]).toEqual({ page_id: 'hub', title: 'Hub', category: 'AI', joins: ['AI', 'Crypto', 'Travel'] });
    const badges = [...mapBridges(buildGraphModel(getWikiGraph(false))).keys()];
    expect(bridges.map((b) => b.page_id)).toEqual(badges);
  });

  it('lists the 6 biggest topics and counts the rest', () => {
    handle = setupTestDb();
    source = seedSource(handle.db, { title: 'A source' });
    for (let t = 0; t < 8; t++) for (let i = 0; i <= t; i++) page(`p${t}-${i}`, `Page ${t} ${i}`, `Topic ${t}`);
    const { clusters } = buildGraphReport();
    expect(clusters.count).toBe(8);
    expect(clusters.top.map((c) => c.name)).toEqual(['Topic 7', 'Topic 6', 'Topic 5', 'Topic 4', 'Topic 3', 'Topic 2']);
  });

  it('reuses a result until the graph changes, or for 5 minutes at most', () => {
    seedWiki();
    const db = handle!.db;
    const first = graphReportCached(db);
    expect(graphReportCached(db)).toBe(first);

    rel('LLM', 'Vilnius'); // a new relation row
    const second = graphReportCached(db);
    expect(second).not.toBe(first);
    expect(second.clusters.top.find((c) => c.name === 'Travel')?.pages).toBe(1);

    // Recategorized in place (no count or update time moves): the timer bounds the wait.
    db.prepare(`UPDATE pages SET category = 'Travel' WHERE page_id = 'llm'`).run();
    expect(graphReportCached(db)).toBe(second);
    const now = Date.now();
    vi.spyOn(Date, 'now').mockReturnValue(now + 5 * 60_000 + 1);
    const third = graphReportCached(db);
    expect(third).not.toBe(second);
    expect(third.clusters.top.find((c) => c.name === 'Travel')?.pages).toBe(2);
  });

  it('refreshes when a page or a source is archived', () => {
    seedWiki();
    const db = handle!.db;
    const other = seedSource(db, { title: 'Another source' });
    seedPage(db, { page_id: 'kaunas', title: 'Kaunas', category: 'Travel' });
    seedProvenance(db, 'kaunas', other);
    const travel = (r: ReturnType<typeof graphReportCached>) => r.clusters.top.find((c) => c.name === 'Travel')?.pages;
    const crypto = (r: ReturnType<typeof graphReportCached>) => r.clusters.top.find((c) => c.name === 'Crypto')?.pages;
    const first = graphReportCached(db);
    expect(travel(first)).toBe(2);

    setSourceStatus(other, 'archived'); // Kaunas now rests only on an archived source
    const second = graphReportCached(db);
    expect(second).not.toBe(first);
    expect(travel(second)).toBe(1);

    archivePage('eth');
    const third = graphReportCached(db);
    expect(third).not.toBe(second);
    expect(crypto(third)).toBe(2);
  });

  it('is part of GET /api/wiki/status', async () => {
    seedWiki();
    const body = (await (await GET()).json()) as Record<string, any>;
    expect(body.clusters.top[0]).toEqual({ name: 'AI', pages: 3, connections: 2 });
    expect(body.bridges[0]).toMatchObject({ page_id: 'hub', joins: ['AI', 'Crypto', 'Travel'] });
  });

  it('still answers wiki_status, without clusters and bridges, when the graph report fails', async () => {
    seedWiki();
    const logged = vi.spyOn(console, 'error').mockImplementation(() => {});
    handle!.db.exec('DROP TABLE relationship_mentions'); // the report reads it; nothing else in status does
    const res = await GET();
    expect(res.status).toBe(200);
    const body = (await res.json()) as Record<string, any>;
    expect(body.gaps.thin_pages).toBeDefined();
    expect(body).not.toHaveProperty('clusters');
    expect(body).not.toHaveProperty('bridges');
    expect(String(logged.mock.calls[0]?.[0])).toContain('wiki_status_graph_report_failed');
  });
});
