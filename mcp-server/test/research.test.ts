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
    expect(res.text).toContain('[1] Bitcoin paper — https://bitcoin.org/bitcoin.pdf · added 2026-10-01 · source_id `s1`\n');
    expect(res.text).toContain(`[2] Mining blog — ${BASE_URL}/source/s2 · added 2026-10-02 · source_id \`s2\`\n`);
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
      "- Bitcoin uses Proof of work [1][3] · 4 sources · Kompl's summary: Bitcoin uses proof of work.",
      // A page outside the pack carries its page_id so it can be read.
      '- Proof of work part of SHA-256 (`sha`) [2]',
      `- Bitcoin related to Proof of work [1] · Kompl's summary: ${long.slice(0, 159)}…`,
    ]);
    expect(res.text).toContain('[3] Third — http://kompl.test/source/s3');
  });

  it("shows the first source's checked sentence as quoted instead of the summary", async () => {
    const kompl = fakeKompl({
      '/api/wiki/research': {
        ...PACK,
        connections: [
          {
            ...connection(['btc', 'Bitcoin'], ['pow', 'Proof of work'], 'Uses', [2, 1], 2, 'Bitcoin uses proof of work.'),
            quote: 'Bitcoin relies on proof of work.',
          },
        ],
      },
    });
    const res = await call(await connect(kompl.fetchImpl), 'research_topic', { topic: 'bitcoin mining' });
    expect(res.text).toContain('- Bitcoin uses Proof of work [2][1] · 2 sources · quoted: "Bitcoin relies on proof of work."');
    expect(res.text).not.toContain("Kompl's summary: Bitcoin uses proof of work.");
  });

  it('marks a relation a newer source supersedes and one whose sources disagree on direction', async () => {
    const kompl = fakeKompl({
      '/api/wiki/research': {
        ...PACK,
        connections: [
          { ...connection(['btc', 'Bitcoin'], ['pow', 'Proof of work'], 'Uses', [1], 1, null), outdated: { source: 2, topic: 'Mining method' } },
          {
            ...connection(['pow', 'Proof of work'], ['btc', 'Bitcoin'], 'Part of', [1], 1, null),
            direction_dispute: { label: 'Includes', sources: [2] },
          },
        ],
      },
    });
    const res = await call(await connect(kompl.fetchImpl), 'research_topic', { topic: 'bitcoin mining' });
    expect(res.text).toContain('- Bitcoin uses Proof of work [1] · may be outdated: [2] says otherwise (changed over time: Mining method)');
    expect(res.text).toContain(
      '- Proof of work part of Bitcoin [1] · sources disagree on direction: [2] read it as "Proof of work includes Bitcoin"'
    );
  });
});

describe('research_topic numbers can be checked with read_source', () => {
  // The pack numbers sources across pages: pow cites the blog first, so the
  // pack's [1] is the blog and [2] the paper. btc numbers its own sources the
  // other way round (paper [1], blog [2]); asking read_source for btc's n=2
  // would return the blog, not the paper the pack's [2] means.
  const pack = {
    ...PACK,
    pages: [
      { ...PACK.pages[0], key_lines: ['Mining uses a lot of energy[1].'] },
      { ...PACK.pages[1], key_lines: ['Bitcoin rewards mining[2].'] },
    ],
    sources: [
      { n: 1, source_id: 'blog', title: 'Mining blog', source_url: null, date_ingested: '2026-10-02 08:00:00', path: '/source/blog' },
      { n: 2, source_id: 'paper', title: 'Bitcoin paper', source_url: 'https://bitcoin.org/bitcoin.pdf', date_ingested: '2026-10-01 08:00:00', path: '/source/paper' },
    ],
  };
  const content = (source_id: string, title: string) => ({
    source_id,
    title,
    source_type: 'url',
    source_url: null,
    status: 'active',
    date_ingested: '2026-10-01 08:00:00',
    total_chars: 5,
    mode: 'text',
    offset: 0,
    text: `${title} text`,
    next_offset: null,
  });

  it('lists each source_id and says to pass it, so the number reaches the right source', async () => {
    const kompl = fakeKompl({
      '/api/wiki/research': pack,
      '/api/wiki/btc/data': {
        page_id: 'btc',
        title: 'Bitcoin',
        page_type: 'entity',
        category: null,
        summary: null,
        source_count: 2,
        last_updated: '2026-10-10 09:00:00',
        content: 'Bitcoin rewards mining[1]. Mining uses energy[2].',
        sources: [
          { n: 1, source_id: 'paper', title: 'Bitcoin paper', contribution_type: 'created' },
          { n: 2, source_id: 'blog', title: 'Mining blog', contribution_type: 'updated' },
        ],
      },
      '/api/sources/paper/content': content('paper', 'Bitcoin paper'),
      '/api/sources/blog/content': content('blog', 'Mining blog'),
    });
    const client = await connect(kompl.fetchImpl);
    const brief = await call(client, 'research_topic', { topic: 'bitcoin mining' });
    expect(brief.text).toContain('- Bitcoin rewards mining[2].');
    expect(brief.text).toContain('[2] Bitcoin paper — https://bitcoin.org/bitcoin.pdf · added 2026-10-01 · source_id `paper`');
    expect(brief.text).toContain('read_source with the source_id');

    // What an agent does: look up [2] in the brief's list and pass its source_id.
    const id = /^\[2\] .* · source_id `([^`]+)`$/m.exec(brief.text)?.[1];
    expect(id).toBe('paper');
    const checked = await call(client, 'read_source', { source_id: id });
    expect(checked.isError).toBe(false);
    expect(checked.text.split('\n').slice(0, 2)).toEqual(['<wiki-data>', '# Bitcoin paper']);
    expect(checked.text).toContain('Bitcoin paper text');
    // The page's own [n] still works for read_page citations.
    const viaPage = await call(client, 'read_source', { page_id: 'btc', n: 1 });
    expect(viaPage.text).toContain('Bitcoin paper text');
  });
});
