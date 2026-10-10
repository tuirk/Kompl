/**
 * What the app's search boxes (TopNav dropdown, /wiki/search) ask for:
 * hybrid search, keyword and meaning matches together (lib/hybrid-search.ts
 * via GET /api/pages/search?mode=hybrid), so plain-language questions find
 * the right page. It leaves out archived pages and Saved Links, like the
 * wiki's normal view. When the meaning half isn't ready yet (right after the
 * NLP service starts) results are keyword-only, without a notice.
 *
 * Each search box waits for a pause in typing (debounce) and keeps one
 * runner: a new query cancels the one still in flight, so a slow answer can
 * never replace the results of a newer query.
 */

import type { SearchHit } from './hybrid-search';

export type { SearchHit };

export function searchUrl(query: string, limit?: number): string {
  const params = new URLSearchParams({ q: query.trim(), mode: 'hybrid' });
  if (limit !== undefined) params.set('limit', String(limit));
  return `/api/pages/search?${params.toString()}`;
}

export interface SearchRunner {
  /** Resolves with the hits, or null when a newer search (or cancel) replaced this one. */
  (query: string, limit?: number): Promise<SearchHit[] | null>;
  /** Drop the search in flight (the box was cleared or left). */
  cancel(): void;
}

export function createSearch(fetchFn: typeof fetch = (input, init) => fetch(input, init)): SearchRunner {
  let current: AbortController | null = null;

  const run = (async (query: string, limit?: number) => {
    current?.abort();
    const own = new AbortController();
    current = own;
    try {
      const res = await fetchFn(searchUrl(query, limit), { signal: own.signal });
      if (!res.ok) throw new Error(`search failed: ${res.status}`);
      const data = (await res.json()) as { items: SearchHit[] };
      return own.signal.aborted ? null : data.items;
    } catch (err) {
      if (own.signal.aborted) return null;
      throw err;
    } finally {
      if (current === own) current = null;
    }
  }) as SearchRunner;

  run.cancel = () => {
    current?.abort();
    current = null;
  };
  return run;
}

/**
 * Calls `fn` once typing pauses for `ms`; each call restarts the wait.
 * `cancel()` drops a call still waiting.
 */
export function debounce<A extends unknown[]>(fn: (...args: A) => void, ms: number) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const debounced = (...args: A) => {
    clearTimeout(timer);
    timer = setTimeout(() => fn(...args), ms);
  };
  debounced.cancel = () => clearTimeout(timer);
  return debounced;
}
