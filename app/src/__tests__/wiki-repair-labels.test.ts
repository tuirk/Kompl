/**
 * The wiki repair's label step (lib/wiki-repair/labels.ts) on the film
 * run's labels (owner decision 2026-10-25), with a fake nlp-service.
 *
 * The Repair run sends every label as new with its page count, so the
 * service can move the smaller label into the bigger one; the merged
 * labels' pages move through the normal page commit (outbox, previous
 * version archived), and no other page is touched.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { readPageMarkdown } from '../lib/db';
import { applyLabelMerges, consolidateWikiLabels, repairLabels } from '../lib/wiki-repair/labels';
import { extractFrontmatterField } from '../lib/yaml-frontmatter';
import { pageMarkdown, writePageFile } from './helpers/repair-wiki';
import { seedPage, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

// The film run's labels after its first compile, with their pages.
const FILM: Array<[string, number]> = [
  ['Graphic Design', 33],
  ['Web Accessibility & Standards', 24],
  ['Arts & Culture', 20],
  ['Design & Accessibility', 20],
  ['Web Development', 7],
  ['Typography & Graphic Design', 6],
  ['Web Accessibility', 2],
  ['Design', 1],
];

function seedFilmWiki(): void {
  let n = 0;
  for (const [label, pages] of FILM) {
    for (let i = 0; i < pages; i++) {
      const page_id = `p${n++}`;
      seedPage(handle!.db, { page_id, title: `${label} ${i}`, page_type: 'entity', category: label, summary: 'A summary.' });
      writePageFile(page_id, pageMarkdown(`${label} ${i}`, label));
    }
  }
}

interface LabelCall {
  existing_labels: string[];
  new_labels: string[];
  page_counts: Record<string, number>;
  compile_model: string;
}

/** Fake nlp-service: the label call answers the two merges the rules allow. */
function stubNlp(): { calls: LabelCall[]; writes: string[] } {
  const calls: LabelCall[] = [];
  const writes: string[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const body = JSON.parse(String(init?.body ?? '{}'));
      if (u.endsWith('/pipeline/consolidate-labels')) {
        calls.push(body as LabelCall);
        const items = [
          { label: 'Web Accessibility', into: 'Web Accessibility & Standards', reason: 'one part' },
          { label: 'Design', into: 'Graphic Design', reason: 'small, contained' },
        ];
        return Response.json({ items, count: items.length });
      }
      if (u.endsWith('/storage/write-page')) {
        const { page_id, markdown } = body as { page_id: string; markdown: string };
        writes.push(page_id);
        writePageFile(page_id, markdown);
        return Response.json({ current_path: `/data/pages/${page_id}.md.gz`, previous_path: `/data/pages/${page_id}.20261025-120000.md.gz` });
      }
      if (u.endsWith('/vectors/upsert')) return Response.json({ ok: true });
      return new Response('not found', { status: 404 });
    }),
  );
  return { calls, writes };
}

const pagesWith = (label: string) =>
  (handle!.db.prepare('SELECT page_id FROM pages WHERE category = ? ORDER BY page_id').all(label) as Array<{ page_id: string }>).map(
    (r) => r.page_id,
  );

describe('wiki repair labels on the film run', () => {
  it('sends every label with its pages and moves the merged pages through the page commit', async () => {
    handle = setupTestDb();
    seedFilmWiki();
    const nlp = stubNlp();
    const moving = [...pagesWith('Web Accessibility'), ...pagesWith('Design')];

    const target = await consolidateWikiLabels(repairLabels(), 'deepseek-flash');
    const outcome = await applyLabelMerges(handle.db, target);

    expect(nlp.calls).toHaveLength(1);
    expect(nlp.calls[0]).toEqual({
      existing_labels: [],
      new_labels: FILM.map(([label]) => label),
      page_counts: Object.fromEntries(FILM),
      compile_model: 'deepseek-flash',
    });
    expect([...target]).toEqual([
      ['Web Accessibility', 'Web Accessibility & Standards'],
      ['Design', 'Graphic Design'],
    ]);
    expect(outcome).toEqual({ merged: 2, pages: 3, missed: 0 });

    expect(pagesWith('Web Accessibility')).toEqual([]);
    expect(pagesWith('Design')).toEqual([]);
    expect(pagesWith('Web Accessibility & Standards')).toHaveLength(26);
    expect(pagesWith('Graphic Design')).toHaveLength(34);
    expect(pagesWith('Typography & Graphic Design')).toHaveLength(6);

    // Only the three moved pages were written, each through the outbox with
    // its previous version kept, and the new label is in the page text too.
    expect(nlp.writes.sort()).toEqual([...moving].sort());
    const rows = handle.db
      .prepare(`SELECT page_id, category, pending_content, previous_content_path FROM pages WHERE page_id IN (${moving.map(() => '?').join(',')})`)
      .all(...moving) as Array<{ page_id: string; category: string; pending_content: string | null; previous_content_path: string | null }>;
    for (const row of rows) {
      expect(row.pending_content).toBeNull();
      expect(row.previous_content_path).toMatch(/\.md\.gz$/);
      expect(extractFrontmatterField(readPageMarkdown(row.page_id)!, 'category')).toBe(row.category);
    }
  });
});
