/**
 * The wiki repair's link step (lib/wiki-repair/links.ts): links a compile
 * wrote through a name match that is now set aside or retired are corrected
 * without any AI call, through the outbox commit, and page_links follows.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';

import { syncPageWikilinks } from '../lib/wikilinks';
import { getPageTitleMap, readPageMarkdown } from '../lib/db';
import { applyLinkFixes, correctAliasLinks, planLinkFixes, unusedAliasPairs } from '../lib/wiki-repair/links';
import { computeRepairPlan } from '../lib/wiki-repair/plan';
import { writePageFile } from './helpers/repair-wiki';
import { seedPage, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

const ctx = (unused: string[][], titles: string[], ownTitle = 'Vilnius') => ({
  unused: new Set(unused.map(([a, c]) => `${a.toLowerCase()}\u0000${c.toLowerCase()}`)),
  titles: new Map(titles.map((t) => [t.toLowerCase(), t])),
  ownTitle,
});

describe('correctAliasLinks', () => {
  it('turns a link made through an unused match into plain words', () => {
    const md = 'Vilnius has [[programming language|English]]-language hotels near [[Kaunas]].';
    const out = correctAliasLinks(md, ctx([['English', 'programming language']], ['programming language', 'Kaunas']));
    expect(out).toEqual({ markdown: 'Vilnius has English-language hotels near [[Kaunas]].', fixed: 1 });
  });

  it('points the link at the page the words exactly title', () => {
    const c = ctx([['LLMs', 'LLM draft path'], ['llm', 'LLM draft path']], ['LLM draft path', 'LLMs', 'LLM']);
    expect(correctAliasLinks('Built on [[LLM draft path|LLMs]].', c).markdown).toBe('Built on [[LLMs]].');
    expect(correctAliasLinks('An [[LLM draft path|llm]] call.', c).markdown).toBe('An [[LLM|llm]] call.');
  });

  it('never links a page to itself', () => {
    const c = ctx([['Vilnius', 'Old Town']], ['Old Town', 'Vilnius']);
    expect(correctAliasLinks('See [[Old Town|Vilnius]].', c).markdown).toBe('See Vilnius.');
  });

  it('leaves links in use, chosen labels, frontmatter and code alone', () => {
    const c = ctx([['English', 'programming language']], ['programming language']);
    const md = [
      '---',
      'summary: "[[programming language|English]]"',
      '---',
      'A [[Vibe coding|vibe coding]] and [[Python|the language]] note.',
      '`[[programming language|English]]`',
      '```',
      '[[programming language|English]]',
      '```',
      '[[programming language]] itself.',
    ].join('\n');
    expect(correctAliasLinks(md, c)).toEqual({ markdown: md, fixed: 0 });
  });
});

describe('unusedAliasPairs', () => {
  it('counts set-aside, retired and number-clash rows, unless an active row makes the same pair', () => {
    handle = setupTestDb();
    const add = handle.db.prepare('INSERT INTO aliases (alias, canonical_name, status) VALUES (?, ?, ?)');
    add.run('English', 'programming language', 'retired');
    add.run('LLMs', 'LLM draft path', 'suspended');
    add.run('Python 3', 'Python 2', 'active');
    add.run('ETH', 'Ethereum', 'suspended');
    add.run('eth', 'ethereum', 'active');
    add.run('Py', 'Python', null);
    const keys = [...unusedAliasPairs(handle.db)].map((k) => k.replace('\u0000', ' -> ')).sort();
    expect(keys).toEqual(['english -> programming language', 'llms -> llm draft path', 'python 3 -> python 2']);

    const llms = (handle.db.prepare("SELECT id FROM aliases WHERE alias = 'LLMs'").get() as { id: number }).id;
    expect(unusedAliasPairs(handle.db, new Set([llms])).has('llms\u0000llm draft path')).toBe(false);
  });
});

describe('applyLinkFixes', () => {
  function seed() {
    handle = setupTestDb();
    const db = handle.db;
    const writes: string[] = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(async (url: string | URL, init?: RequestInit) => {
        const u = String(url);
        if (u.endsWith('/storage/write-page')) {
          const { page_id, markdown } = JSON.parse(String(init?.body)) as { page_id: string; markdown: string };
          writes.push(page_id);
          writePageFile(page_id, markdown);
          return Response.json({ current_path: `/data/pages/${page_id}.md.gz`, previous_path: `/data/pages/${page_id}.1.md.gz` });
        }
        return Response.json({ ok: true });
      }),
    );
    const page = (id: string, title: string, body: string) => {
      seedPage(db, { page_id: id, title, page_type: 'entity' });
      writePageFile(id, `---\ntitle: ${title}\n---\n\n${body}\n`);
    };
    page('trip', 'Vilnius trip', 'Hotels speak [[programming language|English]]; see [[Kaunas]].');
    page('lang', 'programming language', 'Built on [[LLM draft path|LLMs]].');
    page('draft', 'LLM draft path', 'A test page.');
    page('kaunas', 'Kaunas', 'A city.');
    page('saved-links', 'Saved Links', 'Links: [[programming language|English]].');
    const titles = getPageTitleMap();
    for (const id of ['trip', 'lang', 'draft', 'kaunas', 'saved-links']) syncPageWikilinks(db, id, readPageMarkdown(id)!, titles);
    const add = db.prepare('INSERT INTO aliases (alias, canonical_name, status) VALUES (?, ?, ?)');
    add.run('English', 'programming language', 'retired');
    add.run('LLMs', 'LLM draft path', 'suspended');
    return { db, writes };
  }

  const links = (db: TestDbHandle['db'], from: string) =>
    (db.prepare("SELECT target_page_id AS t FROM page_links WHERE source_page_id = ? AND link_type = 'wikilink' ORDER BY t").all(from) as Array<{ t: string }>).map((r) => r.t);

  it('plans, then rewrites each page through the outbox and derives its links again', async () => {
    const { db, writes } = seed();
    expect(links(db, 'trip')).toEqual(['kaunas', 'lang']);

    expect(planLinkFixes(db, unusedAliasPairs(db))).toEqual([
      { page_id: 'lang', title: 'programming language', links: 1 },
      { page_id: 'trip', title: 'Vilnius trip', links: 1 },
    ]);

    const outcome = await applyLinkFixes(db);
    expect(outcome).toEqual({ pages: 2, links: 2, missed: 0 });
    expect(writes.sort()).toEqual(['lang', 'trip']); // Saved Links never touched
    expect(links(db, 'trip')).toEqual(['kaunas']);
    expect(links(db, 'lang')).toEqual([]);
    const row = db.prepare('SELECT pending_content, previous_content_path FROM pages WHERE page_id = ?').get('trip') as Record<string, unknown>;
    expect(row.pending_content).toBeNull();
    expect(row.previous_content_path).toMatch(/\.md\.gz$/);

    // Idempotent: a second pass finds nothing.
    expect(planLinkFixes(db, unusedAliasPairs(db))).toEqual([]);
    expect(await applyLinkFixes(db)).toEqual({ pages: 0, links: 0, missed: 0 });
  });

  it('makes the repair plan list the pages, so a wiki with only wrong links still has something to repair', () => {
    const { db } = seed();
    const plan = computeRepairPlan(db);
    // LLMs -> LLM draft path is set aside and asked about: confirmed, its link stays.
    expect(plan.aliases.map((a) => a.alias)).toEqual(['LLMs']);
    expect([plan.link_pages_low, plan.link_pages_high]).toEqual([1, 2]);
  });

  it('leaves a page whose text waits for the boot reconciler for the next run', async () => {
    const { db, writes } = seed();
    db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?').run(
      '---\ntitle: Vilnius trip\n---\n\nHotels speak [[programming language|English]].\n',
      'trip',
    );
    const outcome = await applyLinkFixes(db);
    expect(outcome).toEqual({ pages: 1, links: 1, missed: 1 });
    expect(writes).toEqual(['lang']);
  });
});
