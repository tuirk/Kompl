import { describe, expect, it } from 'vitest';
import { BASE_URL, call, connect, fakeKompl } from './helpers.js';

const PACK = {
  topic: 'bitcoin mining',
  detail: 'brief',
  degraded: false,
  pages: [
    {
      page_id: 'pow',
      title: 'Proof of work',
      page_type: 'concept',
      category: 'Cryptocurrency',
      summary: 'A consensus mechanism.',
      last_updated: '2026-10-10 09:00:00',
      key_lines: ['Mining secures bitcoin[1].', 'Mining uses a lot of energy[2].'],
      disputes: ['Energy figures'],
      thin: false,
      path: '/wiki/pow',
    },
    {
      page_id: 'btc',
      title: 'Bitcoin',
      page_type: 'entity',
      category: null,
      summary: null,
      last_updated: '2026-10-10 09:00:00',
      key_lines: ['Bitcoin rewards mining[1].'],
      disputes: [],
      thin: true,
      path: '/wiki/btc',
    },
  ],
  sources: [
    { n: 1, source_id: 's1', title: 'Bitcoin paper', source_url: 'https://bitcoin.org/bitcoin.pdf', date_ingested: '2026-10-01 08:00:00', path: '/source/s1' },
    { n: 2, source_id: 's2', title: 'Mining blog', source_url: null, date_ingested: '2026-10-02 08:00:00', path: '/source/s2' },
  ],
  missing_pages: [{ name: 'Satoshi Nakamoto', mentions: 4 }],
  more_pages: [{ page_id: 'sha', title: 'SHA-256', page_type: 'concept' }],
};

describe('research_topic', () => {
  it('lays out the pack with one shared source list, disputes and gaps', async () => {
    const kompl = fakeKompl({ '/api/wiki/research': PACK });
    const res = await call(await connect(kompl.fetchImpl), 'research_topic', { topic: 'bitcoin mining' });
    expect(res.isError).toBe(false);
    expect(res.text).toContain('# Topic: bitcoin mining');
    expect(res.text).toContain('## 1. Proof of work (concept, Cryptocurrency) — `pow`');
    expect(res.text).toContain(`${BASE_URL}/wiki/pow`);
    expect(res.text).toContain('- Mining uses a lot of energy[2].');
    expect(res.text).toContain('Disputed here: Energy figures');
    expect(res.text).toContain(`${BASE_URL}/wiki/btc · rests on one source`);
    expect(res.text).toContain('[1] Bitcoin paper — https://bitcoin.org/bitcoin.pdf · added 2026-10-01');
    expect(res.text).toContain(`[2] Mining blog — ${BASE_URL}/source/s2 · added 2026-10-02`);
    expect(res.text).toContain('**Gaps:** named in several sources but no page: Satoshi Nakamoto (4); resting on one source: Bitcoin.');
    expect(res.text).toContain('**Also relevant:** SHA-256 (`sha`)');
    // An app from before connections: no connections section.
    expect(res.text).not.toContain('How these pages connect');
    expect(Object.fromEntries(kompl.requested[0].searchParams)).toEqual({ topic: 'bitcoin mining', detail: 'brief' });
  });

  it('says when meaning search was unavailable and when nothing was found', async () => {
    const degraded = fakeKompl({ '/api/wiki/research': { ...PACK, degraded: true } }).fetchImpl;
    expect((await call(await connect(degraded), 'research_topic', { topic: 'x' })).text).toContain('keywords only');
    const emptyDegraded = fakeKompl({
      '/api/wiki/research': { ...PACK, degraded: true, pages: [], sources: [], more_pages: [] },
    }).fetchImpl;
    expect((await call(await connect(emptyDegraded), 'research_topic', { topic: 'x' })).text).toContain(
      'Kompl may still have something'
    );
    const empty = fakeKompl({ '/api/wiki/research': { ...PACK, pages: [], sources: [], more_pages: [] } }).fetchImpl;
    expect((await call(await connect(empty), 'research_topic', { topic: 'volcanoes' })).text).toBe(
      'Kompl has no pages on "bitcoin mining". Say so rather than answering from general knowledge.'
    );
  });

  it('points older apps to search_wiki and read_page', async () => {
    const kompl = fakeKompl({ '/api/wiki/research': () => new Response('<html>404</html>', { status: 404 }) });
    const res = await call(await connect(kompl.fetchImpl), 'research_topic', { topic: 'x', detail: 'full' });
    expect(res.isError).toBe(true);
    expect(res.text).toContain('Run `kompl update`');
  });
});

describe('research_topic connections', () => {
  const connection = (from: [string, string], to: [string, string], label: string, sources: number[], source_count: number, sentence: string | null) => ({
    from: { page_id: from[0], title: from[1] },
    to: { page_id: to[0], title: to[1] },
    type: label.toLowerCase().replace(/ /g, '_'),
    label,
    source_count,
    sources,
    sentence,
  });

  it('shows how the pack pages connect, after the pages and before the sources', async () => {
    const long = `${'Bitcoin rewards miners who find proof of work '.repeat(5)}end.`;
    const kompl = fakeKompl({
      '/api/wiki/research': {
        ...PACK,
        sources: [...PACK.sources, { n: 3, source_id: 's3', title: 'Third', source_url: null, date_ingested: null, path: '/source/s3' }],
        connections: [
          connection(['btc', 'Bitcoin'], ['pow', 'Proof of work'], 'Uses', [1, 3], 4, 'Bitcoin uses proof of work.'),
          connection(['pow', 'Proof of work'], ['sha', 'SHA-256'], 'Part of', [2], 1, null),
          connection(['btc', 'Bitcoin'], ['pow', 'Proof of work'], 'Related to', [1], 1, long),
        ],
      },
    });
    const res = await call(await connect(kompl.fetchImpl), 'research_topic', { topic: 'bitcoin mining' });
    const lines = res.text.split('\n');
    const at = lines.indexOf('**How these pages connect:**');
    expect(at).toBeGreaterThan(lines.indexOf('- Bitcoin rewards mining[1].'));
    expect(at).toBeLessThan(lines.indexOf('**Sources** (numbers are shared by all pages above):'));
    expect(lines.slice(at + 1, at + 4)).toEqual([
      '- Bitcoin uses Proof of work — Bitcoin uses proof of work. [1][3] · 4 sources',
      // A page outside the pack carries its page_id so it can be read.
      '- Proof of work part of SHA-256 (`sha`) [2]',
      `- Bitcoin related to Proof of work — ${long.slice(0, 159)}… [1]`,
    ]);
    expect(res.text).toContain('[3] Third — http://kompl.test/source/s3');
  });
});
