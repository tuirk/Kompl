/**
 * GET /api/wiki/[page_id]/related
 *
 * Returns up to 5 wiki pages most similar to the given page, ranked by
 * cosine similarity from Chroma embeddings. Zero LLM cost.
 *
 * Gated by the `related_pages_min_sources` setting (default 100): if the
 * active source count is below the threshold, returns enabled:false so the
 * UI can stay hidden until the wiki has enough content for meaningful results.
 */

import { NextResponse } from 'next/server';
import { getDb, getPage, getRelatedPagesMinSources } from '../../../../../lib/db';

export const dynamic = 'force-dynamic';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';
const MAX_RESULTS = 5;

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

export async function GET(_request: Request, { params }: RouteContext): Promise<NextResponse<RelatedPagesResponse>> {
  const { page_id } = await params;

  const page = getPage(page_id);
  if (!page) {
    return NextResponse.json({ items: [], count: 0, enabled: false }, { status: 404 });
  }

  // Gate on minimum source count
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

  // Fetch similar pages from Chroma via NLP service
  let vectorMatches: Array<{ page_id: string; similarity: number }> = [];
  try {
    const res = await fetch(`${NLP_SERVICE_URL}/vectors/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query_text: queryText, n_results: MAX_RESULTS + 1 }),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        matches: Array<{ page_id: string; similarity: number }>;
      };
      vectorMatches = data.matches ?? [];
    }
  } catch {
    // Embeddings may not be backfilled yet — return empty gracefully
    return NextResponse.json({ items: [], count: 0, enabled: true });
  }

  // Exclude self, resolve titles, take top MAX_RESULTS
  const items: RelatedPageItem[] = [];
  for (const match of vectorMatches) {
    if (match.page_id === page_id) continue;
    const related = getPage(match.page_id);
    if (!related) continue;
    items.push({ page_id: match.page_id, title: related.title, page_type: related.page_type });
    if (items.length >= MAX_RESULTS) break;
  }

  return NextResponse.json({ items, count: items.length, enabled: true });
}
