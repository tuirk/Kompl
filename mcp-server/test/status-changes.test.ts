import { describe, expect, it } from 'vitest';
import { call, connect, fakeKompl, json } from './helpers.js';

const STATS = {
  source_count: 33,
  page_count: 77,
  entity_count: 28,
  concept_count: 14,
  last_ingested: '2026-10-10 11:10:50',
  last_compiled: '2026-10-10 11:11:38',
};
const none = { count: 0, top: [] };
const STATUS = {
  stats: STATS,
  compile_running: null,
  pending_drafts: 2,
  failed_links: { count: 1, top: [{ url: 'https://b.test/', title: null, error: 'dns_failed', date_attempted: 'x' }] },
  vector_backlog: 0,
  stale_sources: { threshold_days: 90, ...none },
  gaps: {
    missing_pages: { count: 6, top: [{ name: 'Vitalik Buterin', mentions: 4 }], capped: false },
    thin_pages: { count: 1, top: [{ page_id: 'pos', title: 'Proof-of-stake', page_type: 'concept', backlinks: 3 }] },
    orphan_pages: none,
    dead_provenance: { count: 0 },
  },
  last_health_check: null,
};

describe('wiki_status', () => {
  it('summarises size, pending work and gaps, without the health check endpoint', async () => {
    const kompl = fakeKompl({ '/api/wiki/status': STATUS, '/api/health': () => json({}, 500) });
    const res = await call(await connect(kompl.fetchImpl), 'wiki_status');
    expect(res.isError).toBe(false);
    expect(res.text).toContain('• Sources: 33 active · Pages: 77 (28 entities, 14 concepts)');
    expect(res.text).toContain('• No compile running');
    expect(res.text).toContain('• Waiting for the user: 2 draft(s) to review · 1 link(s) failed to import');
    expect(res.text).toContain('• Named in 3+ sources but no page (6): Vitalik Buterin (4 sources); and 5 more');
    expect(res.text).toContain('• Pages resting on one source (1): Proof-of-stake (`pos`, linked from 3)');
    expect(res.text).toContain('• Pages with no links in or out: none');
    expect(res.text).toContain('• Failed imports (1): https://b.test/ — dns_failed');
    expect(res.text).toContain('No health check has been run yet');
    expect(kompl.requested.map((u) => u.pathname)).toEqual(['/api/wiki/status']);
  });

  it('shows a running compile and the last health check contradictions', async () => {
    const status = {
      ...STATUS,
      compile_running: { session_id: 's1', started_at: '2026-10-10 12:00:00', source_count: 3 },
      last_health_check: {
        at: '2026-10-09T10:00:00Z',
        contradictions: { count: 1, top: [{ page_a: 'Python Intro', page_b: 'Python History', claim: '1991 vs late 1980s' }] },
      },
    };
    const res = await call(await connect(fakeKompl({ '/api/wiki/status': status }).fetchImpl), 'wiki_status');
    expect(res.text).toContain('• Compile running: session `s1` with 3 source(s), started 2026-10-10 12:00:00');
    expect(res.text).toContain('Python Intro vs Python History: 1991 vs late 1980s');
  });

  it('marks a names count that stopped at the check limit', async () => {
    const status = {
      ...STATUS,
      gaps: { ...STATUS.gaps, missing_pages: { count: 50, top: [{ name: 'A', mentions: 9 }], capped: true } },
    };
    const res = await call(await connect(fakeKompl({ '/api/wiki/status': status }).fetchImpl), 'wiki_status');
    expect(res.text).toContain('• Named in 3+ sources but no page (50+): A (9 sources); and 49+ more');
  });

  it('lists topic clusters and bridge pages, and leaves both out for an app that sends neither', async () => {
    const status = {
      ...STATUS,
      clusters: {
        count: 8,
        top: [
          { name: 'Travel', pages: 25, connections: 18 },
          { name: 'Board Games', pages: 1, connections: 1 },
        ],
      },
      bridges: [
        { page_id: 'btc', title: 'Bitcoin network', category: 'Crypto', joins: ['Crypto', 'AI', 'Travel'] },
        { page_id: 'claude', title: 'Claude', category: 'AI', joins: ['AI', 'Crypto'] },
      ],
    };
    const res = await call(await connect(fakeKompl({ '/api/wiki/status': status }).fetchImpl), 'wiki_status');
    const lines = res.text.split('\n');
    const at = lines.findIndex((l) => l.startsWith('**Topic clusters**'));
    expect(lines[at]).toContain('not counting source pages');
    expect(at).toBeGreaterThan(lines.findIndex((l) => l.startsWith('**Gaps**')));
    expect(lines.slice(at + 1)).toEqual([
      '• Travel: 25 pages, 18 connections inside',
      '• Board Games: 1 page, 1 connection inside',
      '• and 6 more topics',
      '**Bridge pages** (on many of the shortest ways between other pages, with connections in several topics)',
      '• Bitcoin network (`btc`, Crypto) joins Crypto, AI and Travel',
      '• Claude (`claude`, AI) joins AI and Crypto',
    ]);

    const empty = { ...STATUS, clusters: { count: 0, top: [] }, bridges: [] };
    const none = await call(await connect(fakeKompl({ '/api/wiki/status': empty }).fetchImpl), 'wiki_status');
    expect(none.text).toContain('**Topic clusters:** none yet.\n**Bridge pages:** none yet (no page sits between pages of two or more topics).');

    const older = await call(await connect(fakeKompl({ '/api/wiki/status': STATUS }).fetchImpl), 'wiki_status');
    expect(older.text).not.toContain('Topic clusters');
    expect(older.text).not.toContain('Bridge pages');
  });

  it('falls back to the basic counts on an app without the status route', async () => {
    const kompl = fakeKompl({
      '/api/wiki/status': () => new Response('<html>404</html>', { status: 404 }),
      '/api/wiki/stats': STATS,
    });
    const res = await call(await connect(kompl.fetchImpl), 'wiki_status');
    expect(res.isError).toBe(false);
    expect(res.text).toContain('Sources: 33 active');
    expect(res.text).toContain('Run `kompl update`');
  });
});

const PAGE_CHANGE = {
  page_id: 'merge',
  title: 'The Merge',
  page_type: 'concept',
  change: 'created',
  at: '2026-10-10 09:00:00',
  sources: [{ source_id: 's1', title: 'Ethereum blog' }],
  source_total: 1,
};

describe('recent_changes', () => {
  it('lists what changed in the last days, crediting sources', async () => {
    const kompl = fakeKompl({
      '/api/wiki/changes': {
        mode: 'since',
        since: '2026-10-03 12:00:00',
        sources_added: {
          items: [
            {
              source_id: 's1',
              title: 'Ethereum blog',
              source_type: 'url',
              source_url: 'https://e.test/',
              date_ingested: '2026-10-10 08:00:00',
              page_count: 4,
              onboarding_session_id: 'abc',
            },
          ],
          total: 1,
        },
        pages: {
          items: [
            PAGE_CHANGE,
            {
              ...PAGE_CHANGE,
              page_id: 'overview',
              title: 'Overview',
              change: 'updated',
              sources: Array.from({ length: 5 }, (_, i) => ({ source_id: `s${i}`, title: `Source ${i}` })),
              source_total: 9,
            },
          ],
          total: 3,
        },
        disputes: { items: [], total: 0 },
        failures: { items: [], total: 0 },
      },
    });
    const res = await call(await connect(kompl.fetchImpl), 'recent_changes', { days: 7 });
    expect(res.text).toContain('**Changes since 2026-10-03 12:00:00 UTC**');
    expect(res.text).toContain(
      '• Ethereum blog (url, in 4 page(s), added 2026-10-10 08:00:00, session `abc`) https://e.test/'
    );
    expect(res.text).toContain('• Created **The Merge** (`merge`) from Ethereum blog, 2026-10-10 09:00:00');
    expect(res.text).toContain('from Source 0, Source 1, Source 2, Source 3, Source 4 and 4 more');
    expect(res.text).toContain('…and 1 more');
    expect(res.text).not.toContain('Disputes recorded');
    expect(Object.fromEntries(kompl.requested[0].searchParams)).toEqual({ days: '7', limit: '20' });
  });

  it('says when nothing changed', async () => {
    const empty = { items: [], total: 0 };
    const kompl = fakeKompl({
      '/api/wiki/changes': { mode: 'since', since: '2026-10-09 00:00:00', sources_added: empty, pages: empty, disputes: empty, failures: empty },
    });
    expect((await call(await connect(kompl.fetchImpl), 'recent_changes', { since: '2026-10-09' })).text).toBe(
      'No changes since 2026-10-09 00:00:00 UTC.'
    );
  });

  it('follows one compile session, item by item', async () => {
    const kompl = fakeKompl({
      '/api/wiki/changes': {
        mode: 'session',
        session_id: 'abc',
        status: 'completed',
        current_step: 'commit',
        error: null,
        started_at: '2026-10-10 09:00:00',
        completed_at: '2026-10-10 09:02:00',
        staged: {
          items: [
            { item: 'https://ok.test/', status: 'ingested', error: null },
            { item: 'https://bad.test/', status: 'failed', error: 'Could not fetch the page' },
          ],
          total: 2,
        },
        sources_added: { items: [], total: 0 },
        pages: { items: [PAGE_CHANGE], total: 27 },
        failures: { items: [], total: 0 },
      },
    });
    const res = await call(await connect(kompl.fetchImpl), 'recent_changes', { session_id: 'abc', days: 3 });
    expect(res.text).toContain('**Compile session `abc`**: completed, started 2026-10-10 09:00:00, finished 2026-10-10 09:02:00 UTC');
    expect(res.text).toContain('• https://bad.test/: failed (Could not fetch the page)');
    expect(res.text).toContain('Created **The Merge**');
    expect(res.text).toContain('Pages created or updated (27):');
    expect(res.text).toContain('…and 26 more');
    expect(Object.fromEntries(kompl.requested[0].searchParams)).toEqual({ session_id: 'abc', limit: '20' });
  });

  it("shows a page's history and which sections changed", async () => {
    const kompl = fakeKompl({
      '/api/wiki/changes': {
        mode: 'page',
        page: { page_id: 'merge', title: 'The Merge', page_type: 'concept', created_at: '2026-10-01 10:00:00', last_updated: '2026-10-10 09:00:00' },
        compiles: {
          items: [{ source_id: 's1', source_title: 'Ethereum blog', contribution_type: 'updated', at: '2026-10-10 09:00:00' }],
          total: 1,
        },
        events: { items: [{ at: '2026-10-10 09:00:01', kind: 'page_dispute_recorded', detail: 'date' }], total: 1 },
        previous_version: { sections_added: ['Aftermath'], sections_removed: [], sections_changed: ['History'] },
      },
    });
    const res = await call(await connect(kompl.fetchImpl), 'recent_changes', { page_id: 'merge' });
    expect(res.text).toContain('Since the previous version: added: Aftermath; changed: History.');
    expect(res.text).toContain('• 2026-10-10 09:00:00: updated from Ethereum blog (`s1`)');
    expect(res.text).toContain('• 2026-10-10 09:00:01: page dispute recorded (date)');
  });

  it('ignores blank identifiers instead of letting them win', async () => {
    const empty = { items: [], total: 0 };
    const kompl = fakeKompl({
      '/api/wiki/changes': { mode: 'since', since: 'x', sources_added: empty, pages: empty, disputes: empty, failures: empty },
    });
    await call(await connect(kompl.fetchImpl), 'recent_changes', { page_id: '  ', session_id: 'abc' });
    expect(Object.fromEntries(kompl.requested[0].searchParams)).toEqual({ session_id: 'abc', limit: '20' });
  });

  it('asks for an update on an app without the changes route', async () => {
    const kompl = fakeKompl({ '/api/wiki/changes': () => new Response('<html>404</html>', { status: 404 }) });
    expect(await call(await connect(kompl.fetchImpl), 'recent_changes')).toEqual({
      text: "This Kompl app can't report changes yet. Run `kompl update`.",
      isError: true,
    });
  });
});
