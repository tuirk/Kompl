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

describe('read_page sources and links', () => {
  it('shows each source with its address and date, and the page links both ways', async () => {
    const kompl = fakeKompl({ '/api/wiki/pow/data': PAGE });
    const res = await call(await connect(kompl.fetchImpl), 'read_page', { page_id: 'pow' });
    expect(res.text).toContain('  [1] Bitcoin paper — https://bitcoin.org/bitcoin.pdf · compiled 2026-09-30');
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
