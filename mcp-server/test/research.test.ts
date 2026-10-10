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
