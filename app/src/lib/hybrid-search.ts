/**
 * Hybrid page search for AI agents (MCP search_wiki): keyword matches from
 * SQLite FTS5 and meaning matches from the vector index, merged by weighted
 * reciprocal rank fusion. Agents ask questions in plain language, which the
 * strict keyword search used by the app's search box rarely matches.
 *
 * No LLM call. If the vector search fails or is slow, keyword results come
 * back alone with `degraded: true`.
 *
 * Archived pages and the Saved Links system page are never returned.
 */

import { getAllArchivedPageIds, getPage, searchPagesFts, type PageRow } from './db';
import { buildFtsQueryAll, buildFtsQueryAny, buildFtsQueryPairs } from './fts-query';
import { searchPageVectors, type VectorMatch } from './vector-search';

/** Standard RRF constant: damps the gap between the top few ranks. */
const RRF_K = 60;
/**
 * Candidates taken from each side before fusion. Fixed (not derived from the
 * requested limit) so the ranking — and therefore paging with offset — stays
 * the same whatever page size the caller asks for.
 */
const CANDIDATE_POOL = 100;
/**
 * Chroma can't filter by category or type, so a filtered search asks for more
 * vector candidates to still find the matching ones.
 */
const FILTERED_VECTOR_POOL = 300;
/** Never hold an agent's search long for the vector side. */
const VECTOR_TIMEOUT_MS = 1_500;
/**
 * Vector matches below this cosine similarity are dropped. Without a floor,
 * fusion pads the list with unrelated pages. A question scores lower against
 * a page than one page against another, so this sits below the related-pages
 * floor (0.25).
 */
const MIN_QUERY_SIMILARITY = 0.2;
/**
 * Meaning matches must also reach this share of the best match's similarity.
 * When a question has clear matches (Python pages at 0.57–0.66 for "python
 * creator"), loosely related pages just above the absolute floor (AI pages
 * at 0.21–0.37) would otherwise pad the list.
 */
const RELATIVE_SIMILARITY = 0.6;
/**
 * Pages that match only some words of a question (partial keyword search)
 * count half as much as pages matching every word or matching by meaning.
 */
const LOOSE_KEYWORD_WEIGHT = 0.5;
const SAVED_LINKS_PAGE_ID = 'saved-links';

export interface HybridSearchOptions {
  limit: number;
  category?: string;
  pageType?: string;
}

export interface SearchHit {
  page_id: string;
  title: string;
  page_type: string;
  category: string | null;
  summary: string | null;
  source_count: number;
  last_updated: string;
}

export interface HybridSearchResult {
  items: SearchHit[];
  /** True when only keyword matches could be used. */
  degraded: boolean;
}

interface RankedList {
  pages: PageRow[];
  weight: number;
}

export async function hybridSearch(query: string, options: HybridSearchOptions): Promise<HybridSearchResult> {
  const filters = { category: options.category, pageType: options.pageType };
  const filtered = filters.category !== undefined || filters.pageType !== undefined;
  const archived = getAllArchivedPageIds();
  const visible = (page: PageRow | null): page is PageRow =>
    page !== null &&
    page.page_id !== SAVED_LINKS_PAGE_ID &&
    page.page_type !== 'archived' &&
    !archived.has(page.page_id) &&
    (filters.category === undefined || page.category?.toLowerCase() === filters.category.toLowerCase()) &&
    (filters.pageType === undefined || page.page_type === filters.pageType);

  const vector = await searchPageVectors(
    query,
    filtered ? FILTERED_VECTOR_POOL : CANDIDATE_POOL,
    VECTOR_TIMEOUT_MS
  );

  const meaning = vector.ok ? strongVisibleMatches(vector.matches, visible) : [];

  // When meaning search finds something, a page sharing a single word with a
  // several-word question is noise; when it finds nothing, it may be all
  // there is.
  const keyword = keywordSearch(query, filters, { singleWordMatches: meaning.length === 0 });
  const strict = keyword.strict.filter(visible);
  const loose = keyword.loose.filter(visible);

  const items = fuse([
    { pages: strict, weight: 1 },
    { pages: loose, weight: LOOSE_KEYWORD_WEIGHT },
    { pages: meaning, weight: 1 },
  ])
    .slice(0, options.limit)
    .map(toHit);
  return { items, degraded: !vector.ok };
}

/**
 * Pages matching every topic word (strict) and pages matching only some of
 * them (loose): at least two of them, or any one when `singleWordMatches` is
 * set. Common words are left out of both: as prefixes they match unrelated
 * text ("who"* finds "whose"). A query made only of common words ("what is
 * it") has no keyword evidence, so it is left to the meaning side. Search
 * terms are quoted by fts-query, so a query can't reach FTS5 as syntax; a
 * database error empties the keyword side and is logged.
 */
function keywordSearch(
  query: string,
  filters: { category?: string; pageType?: string },
  options: { singleWordMatches: boolean }
): { strict: PageRow[]; loose: PageRow[] } {
  const anyWord = buildFtsQueryAny(query);
  if (anyWord === null) return { strict: [], loose: [] };
  // Pairs are null below three topic words, where "two of them" means all
  // of them, which the strict query already covers.
  const looseQuery = options.singleWordMatches ? anyWord : buildFtsQueryPairs(query);
  try {
    const strictQuery = buildFtsQueryAll(query);
    const strict = strictQuery ? searchPagesFts(strictQuery, CANDIDATE_POOL, filters) : [];
    if (looseQuery === null || looseQuery === strictQuery) return { strict, loose: [] };
    const seen = new Set(strict.map((p) => p.page_id));
    const loose = searchPagesFts(looseQuery, CANDIDATE_POOL, filters).filter((p) => !seen.has(p.page_id));
    return { strict, loose };
  } catch (err) {
    console.warn(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'hybrid_search_keyword_failed',
        error: err instanceof Error ? err.message : String(err),
      })
    );
    return { strict: [], loose: [] };
  }
}

/**
 * Pages of the meaning matches that may be shown (filters, archive), above
 * the absolute floor and close enough to the best of them. The relative
 * floor uses the best *shown* match: a strong match outside the category
 * filter must not push out every match inside it.
 */
function strongVisibleMatches(matches: VectorMatch[], visible: (page: PageRow | null) => page is PageRow): PageRow[] {
  const shown = matches
    .filter((m) => m.similarity >= MIN_QUERY_SIMILARITY)
    .map((m) => ({ page: getPage(m.page_id), similarity: m.similarity }))
    .filter((m): m is { page: PageRow; similarity: number } => visible(m.page));
  const best = Math.max(0, ...shown.map((m) => m.similarity));
  return shown.filter((m) => m.similarity >= best * RELATIVE_SIMILARITY).map((m) => m.page);
}

/** Weighted reciprocal rank fusion: each list adds weight / (K + rank). */
function fuse(lists: RankedList[]): PageRow[] {
  const scored = new Map<string, { page: PageRow; score: number }>();
  for (const { pages, weight } of lists) {
    pages.forEach((page, rank) => {
      const entry = scored.get(page.page_id) ?? { page, score: 0 };
      entry.score += weight / (RRF_K + rank + 1);
      scored.set(page.page_id, entry);
    });
  }
  // Map keeps insertion order and sort is stable, so ties keep keyword order.
  return [...scored.values()].sort((a, b) => b.score - a.score).map((e) => e.page);
}

function toHit(page: PageRow): SearchHit {
  return {
    page_id: page.page_id,
    title: page.title,
    page_type: page.page_type,
    category: page.category,
    summary: page.summary,
    source_count: page.source_count,
    last_updated: page.last_updated,
  };
}
