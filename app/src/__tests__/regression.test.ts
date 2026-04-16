/**
 * Regression tests for three bugs fixed in the QA pass:
 *
 * Bug 1 — stripFrontmatter: truncated frontmatter (no closing \n---\n) caused
 *          raw YAML to render as body text on wiki pages from later sessions.
 *
 * Bug 2 — Crossref batching merge: plan_ids absent from the Gemini cross-cluster
 *          response were replaced with 300-char truncated content instead of the
 *          full clusterResult content, producing partial frontmatter with no close.
 *          (Tested via the merge logic's contract: every plan in clusterResults
 *          must appear in allUpdated with full content.)
 *
 * Bug 3 — Null category filter: null category values from pages with no category
 *          passed the `c !== 'Uncategorized'` filter and flowed to the LLM as the
 *          string "None", causing new pages to be filed under "Uncategorized".
 */

import { describe, it, expect, vi } from 'vitest';
import { stripFrontmatter } from '../lib/markdown';

// ---------------------------------------------------------------------------
// Bug 1 — stripFrontmatter edge cases
// ---------------------------------------------------------------------------

describe('stripFrontmatter', () => {
  it('strips well-formed frontmatter', () => {
    const md = '---\ntitle: "Test"\npage_type: "entity"\n---\n## Heading\nBody text.';
    expect(stripFrontmatter(md)).toBe('## Heading\nBody text.');
  });

  it('returns content unchanged when no frontmatter present', () => {
    const md = '## Heading\nBody text.';
    expect(stripFrontmatter(md)).toBe(md);
  });

  it('returns content unchanged when only opening --- present (truncated)', () => {
    // This was the actual failure: Gemini returned 300-char content with opening
    // --- but no closing \n---\n. stripFrontmatter must not strip — the whole
    // string is returned as-is so the caller can detect the malformed state
    // rather than silently dropping all content.
    const truncated = '---\ntitle: "Google DeepMind"\npage_type: "entity"\ncategory: "AI';
    expect(stripFrontmatter(truncated)).toBe(truncated);
  });

  it('strips frontmatter when closing --- is preceded by content on previous line', () => {
    const md = '---\ntitle: "X"\n---\nFirst line.\nSecond line.';
    expect(stripFrontmatter(md)).toBe('First line.\nSecond line.');
  });

  it('returns empty string when frontmatter is the entire document', () => {
    const md = '---\ntitle: "Empty"\n---\n';
    expect(stripFrontmatter(md)).toBe('');
  });

  it('does not strip when string starts with --- but no trailing newline on opening fence', () => {
    // Must start with exactly '---\n' (with newline) to be treated as frontmatter
    const md = '--- title: "Inline" ---\nBody.';
    expect(stripFrontmatter(md)).toBe(md);
  });
});

// ---------------------------------------------------------------------------
// Bug 2 — Crossref batching merge: every clusterResult plan must survive merge
// ---------------------------------------------------------------------------

/**
 * The crossref batching path calls Gemini with a cross-cluster prompt. Gemini
 * may omit plan_ids from the response. The merge must use clusterResults as the
 * source of truth and only apply cross-cluster additions on top — never replace
 * full content with truncated cross-cluster content.
 *
 * We replicate the merge logic in pure TS here to verify its contract.
 */

interface UpdatedPage {
  plan_id: string;
  markdown: string;
}

function mergeCrossCluster(
  clusterResults: Map<string, UpdatedPage>,
  crossClusterUpdated: UpdatedPage[],
): UpdatedPage[] {
  const crossClusterByPlanId = new Map<string, UpdatedPage>();
  for (const cp of crossClusterUpdated) {
    crossClusterByPlanId.set(cp.plan_id, cp);
  }

  const allUpdated: UpdatedPage[] = [];
  for (const [planId, existing] of clusterResults.entries()) {
    const cp = crossClusterByPlanId.get(planId);
    if (cp) {
      const newLinks = (cp.markdown.match(/\[\[[^\]]+\]\]/g) ?? []).filter(
        (lk) => !existing.markdown.includes(lk),
      );
      if (newLinks.length > 0) {
        existing.markdown += `\n\n${newLinks.join(' ')}`;
      }
    }
    allUpdated.push(existing);
  }
  return allUpdated;
}

describe('crossref batching merge', () => {
  it('preserves all plans from clusterResults even when Gemini omits them', () => {
    const fullMarkdown = '---\ntitle: "Alpha"\npage_type: "entity"\ncategory: "AI"\n---\n## Body\nFull content here.';
    const clusterResults = new Map<string, UpdatedPage>([
      ['plan-1', { plan_id: 'plan-1', markdown: fullMarkdown }],
      ['plan-2', { plan_id: 'plan-2', markdown: '---\ntitle: "Beta"\n---\n## Body\nOther content.' }],
    ]);

    // Gemini only returned plan-1, omitting plan-2 entirely
    const crossClusterUpdated: UpdatedPage[] = [
      { plan_id: 'plan-1', markdown: '---\ntitle: "Alpha"\n---\n[[Beta]]' },
    ];

    const result = mergeCrossCluster(clusterResults, crossClusterUpdated);

    expect(result).toHaveLength(2);
    const plan2 = result.find((p) => p.plan_id === 'plan-2');
    expect(plan2).toBeDefined();
    expect(plan2!.markdown).toContain('Other content.');
  });

  it('appends new wikilinks from cross-cluster but does not replace full content', () => {
    const fullMarkdown = '---\ntitle: "Alpha"\npage_type: "entity"\ncategory: "AI"\n---\n## Body\nFull content here.';
    const clusterResults = new Map<string, UpdatedPage>([
      ['plan-1', { plan_id: 'plan-1', markdown: fullMarkdown }],
    ]);

    const crossClusterUpdated: UpdatedPage[] = [
      { plan_id: 'plan-1', markdown: '---\ntitle: "Alpha"\n---\n[[NewEntity]]' },
    ];

    const result = mergeCrossCluster(clusterResults, crossClusterUpdated);

    expect(result).toHaveLength(1);
    expect(result[0].markdown).toContain('Full content here.');
    expect(result[0].markdown).toContain('[[NewEntity]]');
  });

  it('does not duplicate wikilinks already present in cluster content', () => {
    const fullMarkdown = '---\ntitle: "Alpha"\n---\n## Body\nText [[ExistingLink]] here.';
    const clusterResults = new Map<string, UpdatedPage>([
      ['plan-1', { plan_id: 'plan-1', markdown: fullMarkdown }],
    ]);

    const crossClusterUpdated: UpdatedPage[] = [
      { plan_id: 'plan-1', markdown: '[[ExistingLink]] [[NewLink]]' },
    ];

    const result = mergeCrossCluster(clusterResults, crossClusterUpdated);
    const merged = result[0].markdown;

    // [[ExistingLink]] must not be duplicated
    const occurrences = (merged.match(/\[\[ExistingLink\]\]/g) ?? []).length;
    expect(occurrences).toBe(1);
    // [[NewLink]] must be appended
    expect(merged).toContain('[[NewLink]]');
  });

  it('returns empty array when clusterResults is empty', () => {
    const result = mergeCrossCluster(new Map(), []);
    expect(result).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Bug 4 — Null summary in graph panel: LLM omits summary frontmatter field
// ---------------------------------------------------------------------------

/**
 * The bug: _DRAFT_PAGE_PROMPTS listed summary as a plain bullet with no
 * enforcement. Gemini occasionally omitted the summary: key entirely.
 * The regex on commit/route.ts used \s* which can span newlines — a bare
 * `summary:\n` key would capture the next line's content instead of null.
 *
 * Fix: changed \s* to [ \t]* (horizontal whitespace only) so the regex
 * cannot cross a newline. Also added REQUIRED / MUST language to the prompt.
 */

function extractSummary(markdown: string): string | null {
  const m = markdown.match(/^summary:[ \t]*["']?(.+?)["']?[ \t]*$/m);
  return m?.[1]?.trim() ?? null;
}

describe('summary frontmatter extraction (commit/route.ts:227)', () => {
  it('extracts unquoted single-line summary', () => {
    const md = '---\ntitle: "Test"\nsummary: Claude Code CLI is a command-line tool.\n---\n';
    expect(extractSummary(md)).toBe('Claude Code CLI is a command-line tool.');
  });

  it('extracts double-quoted summary', () => {
    const md = '---\ntitle: "Test"\nsummary: "Claude Code CLI is a command-line tool."\n---\n';
    expect(extractSummary(md)).toBe('Claude Code CLI is a command-line tool.');
  });

  it('extracts single-quoted summary', () => {
    const md = "---\ntitle: \"Test\"\nsummary: 'Claude Code CLI is a tool.'\n---\n";
    expect(extractSummary(md)).toBe('Claude Code CLI is a tool.');
  });

  it('returns null when summary key is absent — the bug scenario', () => {
    const md = '---\ntitle: "Claude Code CLI"\npage_type: entity\ncategory: "Tools"\n---\n## Body\nContent here.';
    expect(extractSummary(md)).toBeNull();
  });

  it('returns null when summary has no inline value (bare key)', () => {
    // [ \t]* cannot cross a newline, so summary:\ntitle: "Test" must not match
    const md = '---\nsummary:\ntitle: "Test"\n---\n';
    expect(extractSummary(md)).toBeNull();
  });

  it('finds summary anywhere in the document (multiline flag)', () => {
    const md = 'title: "Test"\npage_type: entity\nsummary: "Found it."\ncategory: "AI"\n';
    expect(extractSummary(md)).toBe('Found it.');
  });

  it('handles summary with colons in the value', () => {
    const md = 'summary: "Claude Code CLI: a command-line interface for Claude."\n';
    expect(extractSummary(md)).toBe('Claude Code CLI: a command-line interface for Claude.');
  });
});

// ---------------------------------------------------------------------------
// Bug 3 — Null category filter in draft/route.ts baseCategories
// ---------------------------------------------------------------------------

/**
 * The bug: `categories.filter((c) => c !== 'Uncategorized')` passes null values
 * because `null !== 'Uncategorized'` is true. Those nulls then flow to Python
 * where Pydantic serialises them as the string "None", giving the LLM a fake
 * category option and causing new pages to be filed under "Uncategorized".
 *
 * Fix: `categories.filter((c): c is string => c !== null && c !== 'Uncategorized')`
 */

function filterBaseCategories(categories: (string | null)[]): string[] {
  return categories.filter((c): c is string => c !== null && c !== 'Uncategorized');
}

describe('baseCategories null filter', () => {
  it('excludes null values', () => {
    const input: (string | null)[] = ['AI', null, 'Research', null];
    expect(filterBaseCategories(input)).toEqual(['AI', 'Research']);
  });

  it('excludes Uncategorized string', () => {
    const input: (string | null)[] = ['AI', 'Uncategorized', 'Research'];
    expect(filterBaseCategories(input)).toEqual(['AI', 'Research']);
  });

  it('excludes both null and Uncategorized together', () => {
    const input: (string | null)[] = [null, 'Uncategorized', null, 'Tools'];
    expect(filterBaseCategories(input)).toEqual(['Tools']);
  });

  it('returns empty array when all values are null or Uncategorized', () => {
    const input: (string | null)[] = [null, null, 'Uncategorized'];
    expect(filterBaseCategories(input)).toEqual([]);
  });

  it('returns all values when none are null or Uncategorized', () => {
    const input: (string | null)[] = ['AI', 'Research', 'Tools'];
    expect(filterBaseCategories(input)).toEqual(['AI', 'Research', 'Tools']);
  });

  it('preserves order', () => {
    const input: (string | null)[] = ['Zzz', null, 'Aaa', 'Uncategorized', 'Mmm'];
    expect(filterBaseCategories(input)).toEqual(['Zzz', 'Aaa', 'Mmm']);
  });
});

// ---------------------------------------------------------------------------
// Bug 5 — page_links stale wikilinks: wikilink sync logic
// ---------------------------------------------------------------------------

/**
 * The bug: recompile.ts never deleted or re-inserted page_links after redrafting
 * a page (source-deletion path). Old wikilinks from the previous draft stayed in
 * the table; new wikilinks from the redraft were never added.
 *
 * commit/route.ts:361 already had the DELETE. recompile.ts now has the same block.
 *
 * These tests verify the wikilink extraction + dedup logic that both paths share,
 * using mock DB callbacks instead of a native better-sqlite3 binding (which is not
 * prebuilt for Windows Node v22 local dev — works in CI/Docker/Linux).
 */

/**
 * Pure wikilink sync logic extracted for testing.
 * Mirrors the loop in commit/route.ts:363-372 and recompile.ts.
 */
function syncWikilinks(
  markdown: string,
  fromPageId: string,
  titleMap: Map<string, string>,
  dbDelete: (pageId: string) => void,
  dbInsert: (from: string, to: string, type: 'wikilink') => void,
): void {
  dbDelete(fromPageId);
  const rawLinks = markdown.match(/\[\[([^\]]+)\]\]/g) ?? [];
  const seenTargets = new Set<string>();
  for (const link of rawLinks) {
    const title = link.slice(2, -2).trim();
    const toPageId = titleMap.get(title.toLowerCase());
    if (toPageId && toPageId !== fromPageId && !seenTargets.has(toPageId)) {
      seenTargets.add(toPageId);
      dbInsert(fromPageId, toPageId, 'wikilink');
    }
  }
}

describe('page_links wikilink sync', () => {
  it('DELETE is always called before any INSERT — even when markdown has no links', () => {
    const dbDelete = vi.fn();
    const dbInsert = vi.fn();
    syncWikilinks('No wikilinks here.', 'page-a', new Map(), dbDelete, dbInsert);
    expect(dbDelete).toHaveBeenCalledOnce();
    expect(dbDelete).toHaveBeenCalledWith('page-a');
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it('inserts resolved links after the DELETE', () => {
    const dbDelete = vi.fn();
    const dbInsert = vi.fn();
    const titleMap = new Map([['old entity', 'old-entity-page'], ['new entity', 'new-entity-page']]);
    syncWikilinks('## Content\n[[Old Entity]] is replaced by [[New Entity]].', 'source-page', titleMap, dbDelete, dbInsert);
    expect(dbDelete).toHaveBeenCalledWith('source-page');
    expect(dbInsert).toHaveBeenCalledWith('source-page', 'old-entity-page', 'wikilink');
    expect(dbInsert).toHaveBeenCalledWith('source-page', 'new-entity-page', 'wikilink');
    expect(dbInsert).toHaveBeenCalledTimes(2);
  });

  it('deduplicates repeated wikilinks — same target inserted only once', () => {
    const dbInsert = vi.fn();
    const titleMap = new Map([['alpha', 'alpha-page']]);
    syncWikilinks('[[Alpha]] and [[Alpha]] again.', 'source-page', titleMap, vi.fn(), dbInsert);
    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(dbInsert).toHaveBeenCalledWith('source-page', 'alpha-page', 'wikilink');
  });

  it('skips self-links (source page cannot link to itself)', () => {
    const dbInsert = vi.fn();
    const titleMap = new Map([['source page', 'source-page']]);
    syncWikilinks('This page is [[Source Page]].', 'source-page', titleMap, vi.fn(), dbInsert);
    expect(dbInsert).not.toHaveBeenCalled();
  });

  it('skips links whose title is not in the titleMap (unknown pages)', () => {
    const dbInsert = vi.fn();
    const titleMap = new Map([['known', 'known-page']]);
    syncWikilinks('[[Known]] and [[Unknown Page]].', 'source', titleMap, vi.fn(), dbInsert);
    expect(dbInsert).toHaveBeenCalledTimes(1);
    expect(dbInsert).toHaveBeenCalledWith('source', 'known-page', 'wikilink');
  });

  it('title matching is case-insensitive', () => {
    const dbInsert = vi.fn();
    const titleMap = new Map([['gemini', 'gemini-page']]);
    syncWikilinks('[[GEMINI]] and [[Gemini]] and [[gemini]].', 'p', titleMap, vi.fn(), dbInsert);
    expect(dbInsert).toHaveBeenCalledTimes(1);
  });
});
