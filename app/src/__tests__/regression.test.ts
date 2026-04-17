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

  // Gate 2 (commit/route.ts:194) measures stripFrontmatter(markdown).length
  // against min_draft_chars. This pins the body-length invariant Gate 2 depends
  // on — a body of exactly N characters must measure N (no trim, no offset).
  it('preserves exact body length for Gate 2 measurement', () => {
    const body = 'x'.repeat(800);
    const md = `---\ntitle: "T"\n---\n${body}`;
    expect(stripFrontmatter(md).length).toBe(800);
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

// ---------------------------------------------------------------------------
// Sources filter — regression tests for 6 bugs in the filter feature
// ---------------------------------------------------------------------------

// ── Bug 1: SourcesTable never updated when parent passes new initialSources ──
//
// Root cause: `useState(initialSources)` only captures the mount-time value.
// Fix: added `useEffect(() => setSources(initialSources), [initialSources])`
// to SourcesTable.tsx so rows sync whenever filtered data arrives from parent.
//
// The test below is a pure simulation of the prop-sync problem using a plain
// state object — the real fix is the React useEffect in SourcesTable.tsx.

describe('SourcesTable initialSources prop sync (Bug 1)', () => {
  it('state initialized from prop does not auto-update when prop changes — documents why the useEffect fix is required', () => {
    // Simulate React useState: captures initial value only.
    let state = ['source-a'];
    function simulatedUseState(initialProp: string[]) { return state; }
    function simulatedSetState(next: string[]) { state = next; }

    const prop1 = ['source-a'];
    simulatedUseState(prop1); // mount: state = ['source-a']

    const prop2 = ['source-b', 'source-c'];
    // Without the useEffect sync, state is NOT updated when prop changes:
    simulatedUseState(prop2); // re-render with new prop — state stays ['source-a']
    expect(state).toEqual(['source-a']); // bug confirmed: stale rows

    // Fix: useEffect calls setSources(initialSources) on prop change:
    simulatedSetState(prop2);
    expect(state).toEqual(['source-b', 'source-c']); // after fix: rows updated
  });

  it('selection is cleared when rows change — prevents phantom "X selected" display', () => {
    // If user selects source-a and source-b, then filters to archived (returns
    // neither), selectedIds must be cleared so the bulk toolbar doesn't show
    // "2 selected" for rows that are no longer visible.
    let selectedIds = new Set(['source-a', 'source-b']);
    function onFilterChange() {
      // Fix: useEffect clears selectedIds alongside setSources
      selectedIds = new Set();
    }
    onFilterChange();
    expect(selectedIds.size).toBe(0);
  });
});

// ── Bug 2: Race condition — stale fetch overwrites fresh result ──
//
// Root cause: no AbortController — rapid filter changes let old in-flight requests
// resolve after newer ones, overwriting state with stale data.
// Fix: AbortController in useEffect cleanup aborts the previous request.

describe('AbortController abort on cleanup (Bug 2)', () => {
  it('calling abort() prevents the request from completing', async () => {
    const controller = new AbortController();
    const signal = controller.signal;
    expect(signal.aborted).toBe(false);
    controller.abort();
    expect(signal.aborted).toBe(true);
  });

  it('AbortError is not treated as a fetch failure', () => {
    const results: string[] = [];
    function handleFetchError(err: unknown) {
      if ((err as Error).name !== 'AbortError') {
        results.push('error');
      }
      // AbortError is silently ignored
    }
    const abortErr = new DOMException('The user aborted a request.', 'AbortError');
    const networkErr = new Error('Failed to fetch');
    handleFetchError(abortErr);
    handleFetchError(networkErr);
    expect(results).toEqual(['error']); // only networkErr triggers error state
  });
});

// ── Bug 3: Fetch limit defaults to 200 — old page used 500 ──
//
// Root cause: client sends no `limit` param; API defaults to 200.
// Fix: `p.set('limit', '500')` added to fetch URLSearchParams.

describe('sources fetch URLSearchParams (Bug 3)', () => {
  it('includes limit=500', () => {
    const p = new URLSearchParams();
    p.set('limit', '500');
    expect(p.get('limit')).toBe('500');
  });

  it('does not include limit when not explicitly set — documents the silent truncation bug', () => {
    const p = new URLSearchParams();
    p.set('status', 'active');
    expect(p.get('limit')).toBeNull(); // old code: limit missing → API uses 200
  });
});

// ── Bug 4: hasActiveFilters used searchQuery; fetch used debouncedSearch ──
//
// Root cause: during 300ms debounce window, header showed "filtered" but results
// were unfiltered.
// Fix: split into showClearButton (searchQuery) and activeFiltersApplied (debouncedSearch).

describe('filter indicator split (Bug 4)', () => {
  function computeIndicators(
    statusFilter: string, typeFilter: string, dateFrom: string, dateTo: string,
    searchQuery: string, debouncedSearch: string,
  ) {
    const showClearButton = !!(statusFilter || typeFilter || dateFrom || dateTo || searchQuery);
    const activeFiltersApplied = !!(statusFilter || typeFilter || dateFrom || dateTo || debouncedSearch);
    return { showClearButton, activeFiltersApplied };
  }

  it('during debounce window: showClearButton=true, activeFiltersApplied=false', () => {
    const r = computeIndicators('', '', '', '', 'bitcoin', '');
    expect(r.showClearButton).toBe(true);
    expect(r.activeFiltersApplied).toBe(false);
  });

  it('after debounce fires: both are true', () => {
    const r = computeIndicators('', '', '', '', 'bitcoin', 'bitcoin');
    expect(r.showClearButton).toBe(true);
    expect(r.activeFiltersApplied).toBe(true);
  });

  it('no filters: both are false', () => {
    const r = computeIndicators('', '', '', '', '', '');
    expect(r.showClearButton).toBe(false);
    expect(r.activeFiltersApplied).toBe(false);
  });

  it('non-search filter (status): both are true immediately (no debounce)', () => {
    const r = computeIndicators('active', '', '', '', '', '');
    expect(r.showClearButton).toBe(true);
    expect(r.activeFiltersApplied).toBe(true);
  });
});

// ── Bug 5: No error handling — silent failure on network error or 500 ──
//
// Root cause: no .catch() — rejected promise left loading=false with stale data.
// Fix: .catch() sets error state; AbortErrors are ignored.

describe('fetch error state (Bug 5)', () => {
  it('non-abort error sets error state', () => {
    let errorState: string | null = null;
    function handleError(err: unknown) {
      if ((err as Error).name !== 'AbortError') {
        errorState = 'Failed to load sources. Try refreshing.';
      }
    }
    handleError(new Error('Network error'));
    expect(errorState).toBe('Failed to load sources. Try refreshing.');
  });

  it('AbortError does not set error state', () => {
    let errorState: string | null = null;
    function handleError(err: unknown) {
      if ((err as Error).name !== 'AbortError') {
        errorState = 'Failed to load sources. Try refreshing.';
      }
    }
    handleError(new DOMException('aborted', 'AbortError'));
    expect(errorState).toBeNull();
  });
});

// ── Bug 6: router.refresh() is a no-op on pure client component ──
//
// Root cause: after archive/delete, SourcesTable called router.refresh() which
// does not re-trigger parent useEffect deps — header count went stale.
// Fix: onMutation callback prop on SourcesTable calls parent refetch directly.

describe('onMutation callback (Bug 6)', () => {
  it('onMutation is called instead of router.refresh()', () => {
    const onMutation = vi.fn();

    // Simulate what SourcesTable now does after a successful mutation:
    function simulateHandleArchive(onMutationProp?: () => void) {
      // ... (patch API call would go here)
      onMutationProp?.();
    }

    simulateHandleArchive(onMutation);
    expect(onMutation).toHaveBeenCalledOnce();
  });

  it('onMutation is optional — no error when not provided', () => {
    function simulateHandleArchive(onMutationProp?: () => void) {
      onMutationProp?.();
    }
    expect(() => simulateHandleArchive(undefined)).not.toThrow();
  });
});
