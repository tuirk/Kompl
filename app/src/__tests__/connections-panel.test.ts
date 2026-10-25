/**
 * The wiki page's "Connections" card (app/wiki/[page_id]/ConnectionsPanel.tsx
 * and its display rules, lib/connections-view.ts): groups in the read
 * model's order, page links and plain names, evidence with source links and
 * archived sources marked, long groups, "Related to" and "Also linked"
 * behind "Show all", the header's count of related pages, "Also linked"'s
 * own count, the "See in graph" link and the empty state.
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ConnectionsPanel from '../app/wiki/[page_id]/ConnectionsPanel';
import {
  ALSO_LINKED_VISIBLE,
  GROUP_VISIBLE,
  connectionsBreakdown,
  RELATED_VISIBLE,
  connectionsCount,
  hasConnections,
  moreSourcesNote,
  sourcesNote,
  splitRows,
  visibleRowCount,
} from '../lib/connections-view';
import type { ConnectionItem, PageConnections } from '../lib/relations';

function item(over: Partial<ConnectionItem> & Pick<ConnectionItem, 'title'>): ConnectionItem {
  return {
    page_id: over.title.toLowerCase().replace(/\s+/g, '-'),
    type: 'uses',
    direction: 'out',
    source_count: 1,
    evidence: [],
    ...over,
  };
}

function evidence(source_id: string, sentence: string | null, source_archived = false, quote: string | null = null) {
  return { source_id, source_title: `Title ${source_id}`, source_archived, sentence, quote };
}

const related = ['Alpha', 'Beta', 'Gamma', 'Delta', 'Epsilon'].map((title) => item({ title, type: 'related_to' }));
const linked = Array.from({ length: 10 }, (_, i) => ({ page_id: `linked-${i}`, title: `Linked ${i}` }));

const FULL: PageConnections = {
  groups: [
    {
      label: 'Created by',
      items: [item({ page_id: null, title: 'Satoshi Nakamoto', type: 'created_by', source_count: 2 })],
    },
    {
      label: 'Uses',
      items: [
        item({
          title: 'Proof of work',
          source_count: 4,
          evidence: [
            evidence('src-1', 'Bitcoin uses proof of work.'),
            evidence('src-2', 'Miners run proof of work.', true),
            evidence('src-3', null),
          ],
        }),
      ],
    },
    { label: 'Related to', items: related },
  ],
  linked_only: linked,
};

const render = (connections: PageConnections, pageId = 'bitcoin') =>
  renderToString(createElement(ConnectionsPanel, { pageId, connections }));
/** The markup before and inside the n-th "Show all" disclosure of a section. */
function splitAtShowAll(html: string, from: string): { before: string; inside: string } {
  const start = html.indexOf(from);
  const tail = html.slice(start);
  const more = tail.indexOf('<details class="wiki-rp-more">');
  return { before: tail.slice(0, more), inside: tail.slice(more, tail.indexOf('</details>', more)) };
}

describe('connections display rules', () => {
  it('counts the pages and names the page relates to, each once, leaving plain links out', () => {
    expect(connectionsCount(FULL)).toBe(1 + 1 + related.length);
    expect(connectionsCount({ groups: [], linked_only: linked })).toBe(0);
    expect(connectionsCount({ groups: [], linked_only: [] })).toBe(0);
    // One page under two labels, and one name in two cases, count once each.
    const twice: PageConnections = {
      groups: [
        { label: 'Uses', items: [item({ title: 'Proof of work' }), item({ page_id: null, title: 'Satoshi Nakamoto' })] },
        { label: 'Related to', items: [item({ title: 'Proof of work', type: 'related_to' }), item({ page_id: null, title: 'satoshi nakamoto', type: 'related_to' })] },
      ],
      linked_only: [],
    };
    expect(connectionsCount(twice)).toBe(2);
  });

  it('says how many connections have no page yet, so the count explains the map', () => {
    expect(connectionsBreakdown(FULL)).toBe(`${1 + related.length} with a page · 1 with no page yet`);
    expect(connectionsBreakdown({ groups: [FULL.groups[1]], linked_only: [] })).toBeNull();
    expect(connectionsBreakdown({ groups: [FULL.groups[0]], linked_only: [] })).toBe('1 with no page yet');
    const names = [item({ page_id: null, title: 'A' }), item({ page_id: null, title: 'B' })];
    expect(connectionsBreakdown({ groups: [{ label: 'Uses', items: names }], linked_only: [] })).toBe('2 with no page yet');
  });

  it('has something to list when there is a relation or an "Also linked" page', () => {
    expect(hasConnections(FULL)).toBe(true);
    expect(hasConnections({ groups: [], linked_only: linked.slice(0, 1) })).toBe(true);
    expect(hasConnections({ groups: [], linked_only: [] })).toBe(false);
  });

  it('shows the first 3 "Related to" rows and the first 8 of any other group', () => {
    expect(visibleRowCount({ label: 'Related to', items: related })).toBe(RELATED_VISIBLE);
    expect(visibleRowCount(FULL.groups[1])).toBe(GROUP_VISIBLE);
    expect(GROUP_VISIBLE).toBe(8);
    expect(splitRows([1, 2, 3, 4], 3)).toEqual({ shown: [1, 2, 3], rest: [4] });
    expect(splitRows([1, 2], 3)).toEqual({ shown: [1, 2], rest: [] });
  });

  it('notes source counts above one, and sources the evidence leaves out', () => {
    expect(sourcesNote({ source_count: 1 })).toBeNull();
    expect(sourcesNote({ source_count: 3 })).toBe('3 sources');
    expect(moreSourcesNote({ source_count: 3, evidence: [evidence('a', null)] })).toBe('+2 more sources');
    expect(moreSourcesNote({ source_count: 2, evidence: [evidence('a', null)] })).toBe('+1 more source');
    expect(moreSourcesNote({ source_count: 1, evidence: [evidence('a', null)] })).toBeNull();
  });
});

describe('ConnectionsPanel', () => {
  it('says so when the page has no connections, with no graph link', () => {
    const html = render({ groups: [], linked_only: [] });
    expect(html).toContain('Connections');
    expect(html).toContain('No connections yet.');
    expect(html).not.toContain('Also linked');
    expect(html).not.toContain('See in graph');
  });

  it('lists the groups in order, then "Also linked" with its own count, under one counted section', () => {
    const html = render(FULL);
    const labels = [...html.matchAll(/<h3[^>]*>([^<]+)</g)].map((m) => m[1]);
    expect(labels).toEqual(['Created by', 'Uses', 'Related to', 'Also linked']);
    expect(html).toMatch(new RegExp(`Connections<span[^>]*>${connectionsCount(FULL)}</span>`));
    expect(html).toMatch(new RegExp(`Also linked<span[^>]*>${linked.length}</span></h3>`));
    expect(html).toContain(`${1 + related.length} with a page · 1 with no page yet`);
  });

  it('links the header to the graph focused on the page, outside the heading', () => {
    const html = render(FULL, 'bitcoin-network-1c140c9e');
    expect(html).toMatch(/<a [^>]*href="\/wiki\/graph\?focus=bitcoin-network-1c140c9e"[^>]*>.*?See in graph<\/a>/);
    const heading = html.slice(html.indexOf('<h2'), html.indexOf('</h2>'));
    expect(heading).not.toContain('See in graph');
  });

  it('leaves the header count out when only plain links are listed', () => {
    const html = render({ groups: [], linked_only: linked.slice(0, 2) });
    expect(html).toMatch(/>Connections<\/h2>/);
    expect(html).toContain('See in graph');
  });

  it('lists every row of a long group, those past the first 8 as compact rows without evidence', () => {
    const many = Array.from({ length: 11 }, (_, i) =>
      item({ title: `Tool ${i}`, source_count: 2, evidence: [evidence(`src-${i}`, `Bitcoin uses tool ${i}.`)] }));
    const html = render({ groups: [{ label: 'Uses', items: many }], linked_only: [] });
    const { before, inside } = splitAtShowAll(html, '>Uses</h3>');
    // Nothing lost: every row links to its page with its source count.
    for (const r of many) expect(html).toMatch(new RegExp(`href="/wiki/${r.page_id}"[^>]*>.*?>${r.title}</span>.*?· 2 sources`));
    // The first 8 keep their evidence toggle; the rest are compact.
    expect(before.match(/class="wiki-rp-why"/g)).toHaveLength(GROUP_VISIBLE);
    expect(inside).not.toContain('wiki-rp-why');
    expect(inside).not.toContain('Bitcoin uses tool 9.');
    expect(html).toContain('Bitcoin uses tool 7.');
  });

  it('keeps rows of a long group past the first 8 behind "Show all"', () => {
    const many = Array.from({ length: 11 }, (_, i) => item({ title: `Tool ${i}` }));
    const html = render({ groups: [{ label: 'Uses', items: many }], linked_only: [] });
    const { before, inside } = splitAtShowAll(html, '>Uses</h3>');
    for (const r of many.slice(0, GROUP_VISIBLE)) expect(before).toContain(`>${r.title}</span>`);
    for (const r of many.slice(GROUP_VISIBLE)) expect(inside).toContain(`>${r.title}</span>`);
    expect(before).not.toContain('>Tool 8</span>');
    expect(inside).toMatch(/Show all (<!-- -->)?11/);
  });

  it('links a page with its source count, and shows a plain name as having no page yet', () => {
    const html = render(FULL);
    expect(html).toMatch(/href="\/wiki\/proof-of-work"[^>]*>.*?Proof of work.*?· 4 sources/);
    expect(html).toContain('Satoshi Nakamoto');
    expect(html).toContain('· no page yet · 2 sources');
    expect(html).not.toContain('href="/wiki/satoshi');
  });

  it('opens a connection to its sentences and source links, marking archived sources', () => {
    const html = render(FULL);
    const why = html.slice(html.indexOf('<details class="wiki-rp-why">'));
    expect(why).toContain('aria-label="Why: Uses Proof of work"');
    expect(why).toContain('Bitcoin uses proof of work.');
    expect(why).toMatch(/href="\/source\/src-1"[^>]*>Title src-1<\/a><\/span>/);
    expect(why).toMatch(/href="\/source\/src-2"[^>]*>Title src-2<\/a><span[^>]*> \(archived\)<\/span>/);
    expect(why).toMatch(/href="\/source\/src-3"[^>]*>Title src-3<\/a><\/span>/);
    expect(why).toContain('+1 more source');
    // Only the connection with evidence gets a toggle.
    expect(html.match(/class="wiki-rp-why"/g)).toHaveLength(1);
  });

  it("labels each sentence as Kompl's summary, never as the source's words", () => {
    const why = render(FULL).slice(render(FULL).indexOf('<details class="wiki-rp-why">'));
    // The two sentences are each followed by the label and their source; the source without one is just linked.
    expect(why).toMatch(/Bitcoin uses proof of work\.<\/span><span[^>]*>Kompl&#x27;s summary, from <a href="\/source\/src-1"/);
    expect(why).toMatch(/Miners run proof of work\.<\/span><span[^>]*>Kompl&#x27;s summary, from <a href="\/source\/src-2"/);
    expect(why).toMatch(/<li[^>]*><span[^>]*><a href="\/source\/src-3"/);
    expect(why.match(/Kompl&#x27;s summary/g)).toHaveLength(2);
    expect(why).not.toMatch(/[“”"]Bitcoin uses proof of work/);
    expect(why).not.toMatch(/says|quote/i);
  });

  it('keeps "Related to" rows past the first few behind "Show all"', () => {
    const { before, inside } = splitAtShowAll(render(FULL), '>Related to</h3>');
    for (const r of related.slice(0, RELATED_VISIBLE)) expect(before).toContain(`>${r.title}</span>`);
    for (const r of related.slice(RELATED_VISIBLE)) expect(inside).toContain(`>${r.title}</span>`);
    expect(inside).toMatch(/Show all (<!-- -->)?5/);
  });

  it('keeps "Also linked" rows past the first 8 behind "Show all"', () => {
    const { before, inside } = splitAtShowAll(render(FULL), '>Also linked<');
    for (const p of linked.slice(0, ALSO_LINKED_VISIBLE)) expect(before).toContain(`href="/wiki/${p.page_id}"`);
    for (const p of linked.slice(ALSO_LINKED_VISIBLE)) expect(inside).toContain(`href="/wiki/${p.page_id}"`);
    expect(inside).toMatch(/Show all (<!-- -->)?10/);
  });

  it('never puts a link inside a toggle', () => {
    const summaries = [...render(FULL).matchAll(/<summary[^>]*>([\s\S]*?)<\/summary>/g)].map((m) => m[1]);
    expect(summaries).toHaveLength(3); // one evidence toggle, two "Show all"
    for (const s of summaries) expect(s).not.toContain('<a ');
  });

  it('gives a name with no page its evidence toggle, without a page link', () => {
    const html = render({
      groups: [
        {
          label: 'Created by',
          items: [
            item({
              page_id: null,
              title: 'Satoshi Nakamoto',
              type: 'created_by',
              evidence: [evidence('src-1', 'Satoshi Nakamoto created Bitcoin.')],
            }),
          ],
        },
      ],
      linked_only: [],
    });
    expect(html.match(/class="wiki-rp-why"/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Why: Created by Satoshi Nakamoto"');
    expect(html).toContain('href="/source/src-1"');
    // The only wiki link is the header's "See in graph".
    expect(html).not.toMatch(/href="\/wiki\/(?!graph\?)/);
  });

  it('needs no "Show all" for exactly 3 "Related to" rows and exactly 8 plain links', () => {
    const html = render({
      groups: [{ label: 'Related to', items: related.slice(0, RELATED_VISIBLE) }],
      linked_only: linked.slice(0, ALSO_LINKED_VISIBLE),
    });
    expect(html).not.toContain('wiki-rp-more');
    for (const r of related.slice(0, RELATED_VISIBLE)) expect(html).toContain(`>${r.title}</span>`);
    for (const p of linked.slice(0, ALSO_LINKED_VISIBLE)) expect(html).toContain(`href="/wiki/${p.page_id}"`);
  });

  it('shows plain links alone when the page has no typed relations', () => {
    const html = render({ groups: [], linked_only: linked.slice(0, 2) });
    expect(html).not.toContain('No connections yet.');
    expect(html).toContain('Also linked');
    expect(html).not.toContain('wiki-rp-more');
    expect(html).toContain('href="/wiki/linked-1"');
  });
});
