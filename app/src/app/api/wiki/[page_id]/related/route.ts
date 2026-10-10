/**
 * GET /api/wiki/[page_id]/related
 *
 * Returns up to 5 wiki pages similar to the given page, ranked by cosine
 * similarity from Chroma embeddings (local model, no LLM call).
 *
 * Gated by the `related_pages_min_sources` setting (default 10): while the
 * wiki has fewer non-archived sources than that, it returns enabled:false so
 * the panel stays hidden. 0 removes the minimum.
 *
 * Only real matches are listed: archived pages, Saved Links and matches below
 * MIN_RELATED_SIMILARITY are left out, so the list can be shorter than 5 (or
 * empty, which hides the panel) instead of being padded with unrelated pages.
 */

import { NextResponse } from 'next/server';
import { getAllArchivedPageIds, getDb, getPage, getRelatedPagesMinSources } from '../../../../../lib/db';

export const dynamic = 'force-dynamic';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';
const MAX_RESULTS = 5;
/** Candidates asked from Chroma before the filters below drop some. */
const CANDIDATES = 12;
/**
 * Cosine similarity below which a page is not shown as related. On the
 * reference wiki, 0.25 removed every unrelated filler (0.17-0.24) and kept
 * every topical match (lowest 0.29); revisit on larger wikis.
 */
const MIN_RELATED_SIMILARITY = 0.25;
/** The search normally takes well under a second; never hold a page longer. */
const SEARCH_TIMEOUT_MS = 3_000;
const SAVED_LINKS_PAGE_ID = 'saved-links';

interface RelatedPageItem {
  page_id: string;
  title: string;
  page_type: string;
}

interface RelatedPagesResponse {
  items: RelatedPageItem[];
  count: number;
  enabled: boolean;
}

interface RouteContext {
  params: Promise<{ page_id: string }>;
}

function logSearchFailure(page_id: string, detail: Record<string, unknown>): void {
  console.warn(JSON.stringify({ ts: new Date().toISOString(), event: 'related_pages_search_failed', page_id, ...detail }));
}

export async function GET(_request: Request, { params }: RouteContext): Promise<NextResponse<RelatedPagesResponse>> {
  const { page_id } = await params;

  const page = getPage(page_id);
  if (!page) {
    return NextResponse.json({ items: [], count: 0, enabled: false }, { status: 404 });
  }

  // Gate on minimum source count (sources that are not archived)
  const db = getDb();
  const { n: activeSourceCount } = db
    .prepare("SELECT COUNT(*) AS n FROM sources WHERE status = 'active'")
    .get() as { n: number };

  const threshold = getRelatedPagesMinSources();
  if (threshold > 0 && activeSourceCount < threshold) {
    return NextResponse.json({ items: [], count: 0, enabled: false });
  }

  // Build query text from title + summary (no full markdown read needed)
  const queryText = page.summary
    ? `${page.title}. ${page.summary}`
    : page.title;

  // Fetch similar pages from Chroma via NLP service. An empty store answers
  // 200 with no matches; anything else is a failure worth a log line.
  let vectorMatches: Array<{ page_id: string; similarity: number }> = [];
  try {
    const res = await fetch(`${NLP_SERVICE_URL}/vectors/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query_text: queryText, n_results: CANDIDATES }),
      signal: AbortSignal.timeout(SEARCH_TIMEOUT_MS),
    });
    if (!res.ok) {
      logSearchFailure(page_id, { status: res.status });
    } else {
      const data = (await res.json()) as {
        matches: Array<{ page_id: string; similarity: number }>;
      };
      vectorMatches = data.matches ?? [];
    }
  } catch (err) {
    logSearchFailure(page_id, { error: err instanceof Error ? err.message : String(err) });
    return NextResponse.json({ items: [], count: 0, enabled: true });
  }

  // Exclude self, Saved Links (a system page of unresolved URLs, not content),
  // archived pages and weak matches; resolve titles; take the top MAX_RESULTS.
  const archived = getAllArchivedPageIds();
  const items: RelatedPageItem[] = [];
  for (const match of vectorMatches) {
    if (match.page_id === page_id) continue;
    if (match.page_id === SAVED_LINKS_PAGE_ID) continue;
    if (!(match.similarity >= MIN_RELATED_SIMILARITY)) continue;
    if (archived.has(match.page_id)) continue;
    const related = getPage(match.page_id);
    if (!related || related.page_type === 'archived') continue;
    items.push({ page_id: match.page_id, title: related.title, page_type: related.page_type });
    if (items.length >= MAX_RESULTS) break;
  }

  return NextResponse.json({ items, count: items.length, enabled: true });
}
