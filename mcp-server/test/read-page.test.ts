import { describe, expect, it } from 'vitest';
import { call, connect, fakeKompl, json } from './helpers.js';

const PAGE = {
  page_id: 'pow',
  title: 'Proof of work',
  page_type: 'concept',
  category: 'Cryptocurrency',
  summary: 'A consensus mechanism.',
  source_count: 1,
  last_updated: '2026-10-01 10:00:00',
  content: 'Miners compete[1].',
  sources: [
    {
      n: 1,
      source_id: 's1',
      title: 'Bitcoin paper',
      contribution_type: 'created',
      source_url: 'https://bitcoin.org/bitcoin.pdf',
      date: '2026-09-30 08:00:00',
    },
  ],
  links: [{ page_id: 'bitcoin', title: 'Bitcoin' }],
  backlinks: [{ page_id: 'satoshi', title: 'Satoshi Nakamoto' }],
};

describe('read_page sources and links (apps from before connections)', () => {
  it('shows each source with its address and date, and the page links both ways', async () => {
    const kompl = fakeKompl({ '/api/wiki/pow/data': PAGE });
    const res = await call(await connect(kompl.fetchImpl), 'read_page', { page_id: 'pow' });
    expect(res.text).toContain('  [1] Bitcoin paper — https://bitcoin.org/bitcoin.pdf · compiled 2026-09-30 · source_id `s1`\n');
    expect(res.text).toContain('**Links to:** Bitcoin (`bitcoin`)');
    expect(res.text).toContain('**Linked from:** Satoshi Nakamoto (`satoshi`)');
    expect(res.text).not.toContain('**Related:**');
    expect(kompl.requested.map((u) => u.pathname)).toEqual(['/api/wiki/pow/data']);
  });

  it('cuts long link lists and counts the rest', async () => {
    const links = Array.from({ length: 23 }, (_, i) => ({ page_id: `p${i}`, title: `Page ${i}` }));
    const kompl = fakeKompl({ '/api/wiki/pow/data': { ...PAGE, links } });
    const res = await call(await connect(kompl.fetchImpl), 'read_page', { page_id: 'pow' });
    expect(res.text).toContain('Page 19 (`p19`), and 3 more');
    expect(res.text).not.toContain('Page 20 (');
  });
});

describe('read_page disagreements', () => {
  it('lists each recorded disagreement, its sources and whether the user confirmed it, inside the fence', async () => {
    const disagreements = [
      {
        kind: 'disputed', status: 'possible', found_by: 'page_text', topic: 'Launch year', reason: null,
        sources: [{ n: 1, source_id: 's1', title: 'Bitcoin paper' }, { n: null, source_id: 's9', title: 'Old blog' }],
        quote_a: null, quote_b: null, found_at: '2026-10-01 10:00:00',
      },
      {
        kind: 'contradiction', status: 'confirmed', found_by: 'triage', topic: '', reason: 'Gives a later year.',
        sources: [{ n: 1, source_id: 's1', title: 'Bitcoin paper' }],
        quote_a: 'Launched in 2009.', quote_b: 'Launched in 2010.', found_at: '2026-10-02 10:00:00',
      },
    ];
    const kompl = fakeKompl({ '/api/wiki/pow/data': { ...PAGE, disagreements } });
    const res = await call(await connect(kompl.fetchImpl), 'read_page', { page_id: 'pow' });
    expect(res.text).toContain('**Disagreements recorded on this page:**');
    expect(res.text).toContain('- Disputed: Launch year · [1] (source: Old blog, `s9`) · not yet confirmed by the user');
    expect(res.text).toContain('- Contradiction: Gives a later year. · [1] · confirmed by the user');
    expect(res.text).toContain('  Quotes: "Launched in 2009." vs "Launched in 2010."');
    // Wiki text: inside the fence, before Kompl's own closing line.
    expect(res.text.indexOf('Disagreements recorded')).toBeLessThan(res.text.indexOf('</wiki-data>'));
  });

  it('says nothing about disagreements when the app sends none (older apps)', async () => {
    const kompl = fakeKompl({ '/api/wiki/pow/data': PAGE });
    const res = await call(await connect(kompl.fetchImpl), 'read_page', { page_id: 'pow' });
    expect(res.text).not.toContain('Disagreements');
  });
});

describe('read_page include_related', () => {
  const withRelated = (related: unknown) =>
    fakeKompl({ '/api/wiki/pow/data': PAGE, '/api/wiki/pow/related': related }).fetchImpl;

  it('lists related pages', async () => {
    const fetchImpl = withRelated({
      items: [{ page_id: 'pos', title: 'Proof of stake', page_type: 'concept' }],
      count: 1,
      enabled: true,
    });
    const res = await call(await connect(fetchImpl), 'read_page', { page_id: 'pow', include_related: true });
    expect(res.text).toContain('**Related:** Proof of stake (`pos`)');
  });

  it('explains when related pages are not available', async () => {
    const off = await call(await connect(withRelated({ items: [], count: 0, enabled: false })), 'read_page', {
      page_id: 'pow',
      include_related: true,
    });
    expect(off.text).toContain('**Related:** shown once the wiki has enough sources');
    const failed = await call(await connect(withRelated(() => json({ error: 'nlp_down' }, 503))), 'read_page', {
      page_id: 'pow',
      include_related: true,
    });
    expect(failed.isError).toBe(false);
    expect(failed.text).toContain('**Related:** unavailable (nlp_down)');
  });
});

const ev = (source_id: string, source_title: string, sentence: string | null, source_archived = false) => ({
  source_id,
  source_title,
  source_archived,
  sentence,
});
const item = (title: string, page_id: string | null, type: string, evidence: unknown[], source_count = evidence.length) => ({
  page_id,
  title,
  type,
  direction: 'out',
  source_count,
  evidence,
});
const CONNECTIONS = {
  groups: [
    { label: 'Part of', items: [item('Consensus', 'consensus', 'part_of', [ev('s1', 'Bitcoin paper', 'Proof of work is one way to reach consensus.')])] },
    {
      label: 'Uses',
      items: [
        item(
          'SHA-256',
          'sha',
          'uses',
          // The newest sentence comes from a source the page does not cite: the cited one is shown instead.
          [ev('s9', 'Old blog', 'Proof of work leans on SHA-256.'), ev('S1', 'Bitcoin paper', 'Proof of work uses SHA-256.')],
          3
        ),
      ],
    },
    { label: 'Used by', items: [item('Mining pools', null, 'uses', [ev('s9', 'Old blog', 'Mining pools use proof of work.', true)])] },
    {
      label: 'Related to',
      items: [
        item('Energy use', 'energy', 'related_to', [ev('s1', 'Bitcoin paper', null)]),
        item('Hashcash', 'hashcash', 'related_to', [ev('s1', 'Bitcoin paper', 'Hashcash came first.', true)]),
      ],
    },
  ],
  linked_only: [{ page_id: 'satoshi', title: 'Satoshi Nakamoto' }],
};

describe('read_page connections', () => {
  const read = async (connections: unknown, args: Record<string, unknown> = {}) => {
    const kompl = fakeKompl({
      '/api/wiki/pow/data': { ...PAGE, connections },
      '/api/wiki/pow/related': { items: [{ page_id: 'pos', title: 'Proof of stake', page_type: 'concept' }], count: 1, enabled: true },
    });
    return (await call(await connect(kompl.fetchImpl), 'read_page', { page_id: 'pow', ...args })).text;
  };

  it('lists each relation with its evidence and the page source behind it, instead of the plain link lists', async () => {
    const text = await read(CONNECTIONS, { include_related: true });
    const lines = text.split('\n');
    const start = lines.indexOf('**Connections:**');
    expect(start).toBeGreaterThan(lines.indexOf('  [1] Bitcoin paper — https://bitcoin.org/bitcoin.pdf · compiled 2026-09-30'));
    // The sentence is Kompl's summary of the relation, labelled so, after the source it was read from.
    expect(lines.slice(start + 1, start + 7)).toEqual([
      "- Part of: Consensus (`consensus`) [1] · Kompl's summary: Proof of work is one way to reach consensus.",
      "- Uses: SHA-256 (`sha`) [1] · 3 sources · Kompl's summary: Proof of work uses SHA-256.",
      // A source the page does not cite: named, with the id read_source takes.
      "- Used by: Mining pools (no page) (source: Old blog, `s9`, archived) · Kompl's summary: Mining pools use proof of work.",
      '- Related to: Energy use (`energy`) [1]',
      "- Related to: Hashcash (`hashcash`) [1] (archived source) · Kompl's summary: Hashcash came first.",
      '**Also linked:** Satoshi Nakamoto (`satoshi`)',
    ]);
    expect(text).not.toContain('**Links to:**');
    expect(text).not.toContain('**Linked from:**');
    expect(text).toContain('**Related:** Proof of stake (`pos`)');
  });

  it("shows a checked source sentence as quoted, ahead of summaries (the evidence above, as older apps send it, has none)", async () => {
    const quoted = (source_id: string, title: string, sentence: string, quote: string) => ({ ...ev(source_id, title, sentence), quote });
    const long = `${'Miners hash block headers with SHA-256 again and again '.repeat(6)}end.`;
    const text = await read({
      groups: [
        {
          label: 'Uses',
          items: [
            // A quote beats a summary from a cited source, and a cited quote beats an uncited one.
            item('SHA-256', 'sha', 'uses', [
              ev('s1', 'Bitcoin paper', 'Proof of work uses SHA-256.'),
              quoted('s9', 'Old blog', 'Blog summary.', 'Mining runs SHA-256 twice.'),
              quoted('S1', 'Bitcoin paper', 'Paper summary.', 'We use SHA-256 for proof of work.'),
            ]),
            item('Hashcash', 'hashcash', 'uses', [quoted('s9', 'Old blog', 'Summary.', 'Proof of work comes from Hashcash.')]),
            item('Headers', 'headers', 'uses', [quoted('s1', 'Bitcoin paper', 'Summary.', long)]),
          ],
        },
      ],
      linked_only: [],
    });
    const rows = text.split('\n').filter((l) => l.startsWith('- Uses: '));
    expect(rows).toEqual([
      '- Uses: SHA-256 (`sha`) [1] · 3 sources · quoted: "We use SHA-256 for proof of work."',
      '- Uses: Hashcash (`hashcash`) (source: Old blog, `s9`) · quoted: "Proof of work comes from Hashcash."',
      `- Uses: Headers (\`headers\`) [1] · quoted: "${long.slice(0, 239)}…"`,
    ]);
    expect(text).not.toContain('Paper summary.');
  });

  it('shows 15 relations with one clipped sentence each, then names the pages among the rest; Also linked stops at 20', async () => {
    const long = `${'A very long sentence about proof of work '.repeat(8)}end.`;
    const many = Array.from({ length: 18 }, (_, i) => item(`Page ${i}`, `p${i}`, 'related_to', [ev('s1', 'Bitcoin paper', long), ev('s2', 'Other', 'Second.')]));
    const linked = Array.from({ length: 23 }, (_, i) => ({ page_id: `l${i}`, title: `Linked ${i}` }));
    const text = await read({ groups: [{ label: 'Related to', items: many }], linked_only: linked });
    const rows = text.split('\n').filter((l) => l.startsWith('- Related to: '));
    expect(rows).toHaveLength(15);
    expect(rows[0]).toBe(`- Related to: Page 0 (\`p0\`) [1] · 2 sources · Kompl's summary: ${long.slice(0, 159)}…`);
    expect(text).not.toContain('Second.');
    expect(text).toContain('\n+3 more, among them Page 15 (`p15`), Page 16 (`p16`), Page 17 (`p17`)\n');
    expect(text).toContain('Linked 19 (`l19`), and 3 more');
    expect(text).not.toContain('Linked 20 (');
  });

  it('names a hidden page once, never one already shown or a plain name, and stops at 20', async () => {
    const one = (title: string, page_id: string | null, type = 'part_of') => item(title, page_id, type, [ev('s1', 'Bitcoin paper', null)]);
    const shown = Array.from({ length: 15 }, (_, i) => one(`Part ${i}`, `p${i}`));
    const hidden = [
      one('Part 3', 'p3', 'related_to'), // its page already has a full line
      one('Name only', null, 'related_to'),
      ...Array.from({ length: 22 }, (_, i) => one(`Q ${i}`, `q${i}`, 'related_to')),
      one('Q 0', 'q0', 'related_to'), // the same page twice among the rest
    ];
    const text = await read({ groups: [{ label: 'Part of', items: shown }, { label: 'Related to', items: hidden }], linked_only: [] });
    const more = text.split('\n').find((l) => l.startsWith('+'));
    const q = Array.from({ length: 20 }, (_, i) => `Q ${i} (\`q${i}\`)`).join(', ');
    expect(more).toBe(`+25 more, among them ${q}, and 2 more`);
    expect(text.split('(`p3`)')).toHaveLength(2);
    expect(text).not.toContain('Name only');
  });

  it('keeps the strongest 15 in full: specific relations first, then most sources, printed in label order', async () => {
    const one = (title: string, page_id: string, type: string, sources: number) => item(title, page_id, type, [ev('s1', 'Bitcoin paper', null)], sources);
    const parts = Array.from({ length: 15 }, (_, i) => one(`Part ${i}`, `p${i}`, 'part_of', 1));
    const text = await read({
      groups: [
        { label: 'Part of', items: parts },
        { label: 'Uses', items: [one('Heavy', 'heavy', 'uses', 10)] },
        { label: 'Related to', items: [one('Popular', 'popular', 'related_to', 20)] },
      ],
      linked_only: [],
    });
    const rows = text.split('\n').filter((l) => l.startsWith('- '));
    expect(rows).toHaveLength(15);
    expect(rows[13]).toBe('- Part of: Part 13 (`p13`) [1]');
    expect(rows[14]).toBe('- Uses: Heavy (`heavy`) [1] · 10 sources');
    expect(text).toContain('\n+2 more, among them Part 14 (`p14`), Popular (`popular`)\n');
  });

  it('lists exactly 15 with no count line, and an item without evidence by its source count', async () => {
    const fifteen = Array.from({ length: 14 }, (_, i) => item(`Part ${i}`, `p${i}`, 'part_of', [ev('s1', 'Bitcoin paper', null)]));
    const text = await read({ groups: [{ label: 'Part of', items: fifteen }, { label: 'Uses', items: [item('Bare', 'bare', 'uses', [], 2)] }], linked_only: [] });
    expect(text.split('\n').filter((l) => l.startsWith('- '))).toHaveLength(15);
    expect(text).toContain('\n- Uses: Bare (`bare`) · 2 sources\n');
    expect(text.split('\n').some((l) => l.startsWith('+'))).toBe(false);
  });

  it('says when a page has no connections, even if an older field lists links', async () => {
    const text = await read({ groups: [], linked_only: [] });
    expect(text).toContain('**Connections:** none yet.');
    expect(text).not.toContain('**Links to:**');
  });
});
