/**
 * The wiki repair's wrong-sense link step (lib/wiki-repair/senses.ts) and
 * source title step (lib/wiki-repair/titles.ts): both free, both after the
 * run's backup; page text changes through the outbox commit.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { getPageTitleMap, readPageMarkdown } from '../lib/db';
import { computeRepairPlan } from '../lib/wiki-repair/plan';
import { applySenseFixes, planSenseFixes, unlinkWrongSense, wordCase } from '../lib/wiki-repair/senses';
import { applyTitleFixes, countTitleFixes, oneLine } from '../lib/wiki-repair/titles';
import { syncPageWikilinks } from '../lib/wikilinks';
import { writePageFile } from './helpers/repair-wiki';
import { seedPage, seedProvenance, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

const words = (...w: string[]) => new Set(w);

describe('wordCase', () => {
  it('tells a word only ever lowercase from one ever capitalised', () => {
    expect(wordCase('Vertigo', ['positional vertigo and dizziness'])).toBe('lowercase');
    expect(wordCase('Vertigo', ['positional vertigo', 'Vertigo is a symptom'])).toBe('capitalised');
    expect(wordCase('Vertigo', ['vertigo-free', 'nothing here'])).toBe('lowercase');
    expect(wordCase('Vertigo', ['no mention', 'vertigos'])).toBe('absent');
  });
});

describe('unlinkWrongSense', () => {
  it('turns the link into lowercase words, and keeps the capital at a sentence start', () => {
    const md = 'Benign positional [[Vertigo]] is common. [[Vertigo]] lasts minutes; a [[Vertigo|vertigo]] spell.';
    expect(unlinkWrongSense(md, words('Vertigo'))).toEqual({
      markdown: 'Benign positional vertigo is common. Vertigo lasts minutes; a vertigo spell.',
      fixed: 3,
    });
  });

  it('leaves other words, chosen labels, lines of their own, code and frontmatter alone', () => {
    const md = [
      '---',
      'summary: "[[Vertigo]]"',
      '---',
      'See [[Tinnitus]] and [[Vertigo|the film]].',
      '- [[Vertigo]]',
      '`[[Vertigo]]` stays.',
      '```',
      'a [[Vertigo]] b',
      '```',
    ].join('\n');
    expect(unlinkWrongSense(md, words('Vertigo'))).toEqual({ markdown: md, fixed: 0 });
  });
});

describe('applySenseFixes', () => {
  function seed(sourceTexts: Record<string, string | null>, pageSources: string[]) {
    handle?.cleanup();
    handle = setupTestDb();
    const db = handle.db;
    const writes: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        if (String(url).endsWith('/storage/write-page')) {
          const { page_id, markdown } = JSON.parse(String(init?.body)) as { page_id: string; markdown: string };
          writes.push(page_id);
          writePageFile(page_id, markdown);
          return Response.json({ current_path: `/data/pages/${page_id}.md.gz`, previous_path: `/data/pages/${page_id}.1.md.gz` });
        }
        return Response.json({ ok: true });
      }),
    );
    for (const [id, raw_markdown] of Object.entries(sourceTexts)) seedSource(db, { source_id: id, ...(raw_markdown === null ? {} : { raw_markdown }) });
    const page = (id: string, title: string, body: string) => {
      seedPage(db, { page_id: id, title, page_type: 'entity' });
      writePageFile(id, `---\ntitle: ${title}\n---\n\n${body}\n`);
    };
    page('bppv', 'BPPV', 'Benign paroxysmal positional [[Vertigo]] is common; see [[Tinnitus]].');
    page('film', 'Vertigo', 'A 1958 film.');
    page('tin', 'Tinnitus', 'Ringing.');
    for (const s of pageSources) seedProvenance(db, 'bppv', s);
    for (const id of ['bppv', 'film', 'tin']) syncPageWikilinks(db, id, readPageMarkdown(id)!, getPageTitleMap());
    return { db, writes };
  }

  const linked = (db: TestDbHandle['db']) =>
    (db.prepare("SELECT target_page_id AS t FROM page_links WHERE source_page_id = 'bppv' AND link_type = 'wikilink' ORDER BY t").all() as Array<{ t: string }>).map((r) => r.t);

  it('unlinks through the outbox when the page sources only write the word in lowercase', async () => {
    const { db, writes } = seed({ s1: 'Positional vertigo is a spinning feeling. Tinnitus too.' }, ['s1']);
    // "Positional vertigo": lowercase; no capitalised "Vertigo" anywhere.
    expect(linked(db)).toEqual(['film', 'tin']);
    expect(planSenseFixes(db)).toEqual([{ page_id: 'bppv', title: 'BPPV', links: 1 }]);
    expect(computeRepairPlan(db)).toMatchObject({ sense_pages: 1, sense_links: 1 });

    expect(await applySenseFixes(db)).toEqual({ pages: 1, links: 1, missed: 0 });
    expect(writes).toEqual(['bppv']);
    expect(readPageMarkdown('bppv')).toContain('Benign paroxysmal positional vertigo is common; see [[Tinnitus]].');
    expect(linked(db)).toEqual(['tin']);
    const row = db.prepare('SELECT pending_content, previous_content_path FROM pages WHERE page_id = ?').get('bppv') as Record<string, unknown>;
    expect(row.pending_content).toBeNull();
    expect(row.previous_content_path).toMatch(/\.md\.gz$/);
    expect(await applySenseFixes(db)).toEqual({ pages: 0, links: 0, missed: 0 });
  });

  it('leaves the link when a source capitalises the word, there is no source, or one cannot be read', async () => {
    const cases: Array<[Record<string, string | null>, string[]]> = [
      [{ s1: 'a vertigo spell. Hitchcock made Vertigo.' }, ['s1']],
      [{ s1: 'a vertigo spell.' }, []],
      [{ s1: 'a vertigo spell.', s2: null }, ['s1', 's2']],
    ];
    for (const [texts, sources] of cases) {
      const { db, writes } = seed(texts, sources);
      expect(planSenseFixes(db)).toEqual([]);
      expect(await applySenseFixes(db)).toEqual({ pages: 0, links: 0, missed: 0 });
      expect(writes).toEqual([]);
    }
  });

  it('leaves a page whose text waits for the boot reconciler for the next run', async () => {
    const { db, writes } = seed({ s1: 'a vertigo spell.' }, ['s1']);
    db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?').run('---\ntitle: BPPV\n---\n\nA [[Vertigo]] spell.\n', 'bppv');
    expect(await applySenseFixes(db)).toEqual({ pages: 0, links: 0, missed: 1 });
    expect(writes).toEqual([]);
  });
});

describe('source titles', () => {
  it('puts every title on one line, in one pass, and only those', () => {
    handle = setupTestDb();
    const db = handle.db;
    seedSource(db, { source_id: 'a', title: '\n\t\tOn automatically generating contrasting text\n    colors with CSS' });
    seedSource(db, { source_id: 'b', title: 'Already  clean?' });
    seedSource(db, { source_id: 'c', title: 'Fine' });
    seedSource(db, { source_id: 'd', title: ' \n ' });
    expect(oneLine('\n\t\tA \n  b ')).toBe('A b');
    expect(countTitleFixes(db)).toBe(2);
    expect(computeRepairPlan(db).title_sources).toBe(2);

    expect(applyTitleFixes(db)).toBe(2);
    const title = (id: string) => (db.prepare('SELECT title FROM sources WHERE source_id = ?').get(id) as { title: string }).title;
    expect(title('a')).toBe('On automatically generating contrasting text colors with CSS');
    expect(title('b')).toBe('Already clean?');
    expect(title('c')).toBe('Fine');
    expect(title('d')).toBe(' \n '); // only whitespace: left as it is
    expect(applyTitleFixes(db)).toBe(0);
  });
});
