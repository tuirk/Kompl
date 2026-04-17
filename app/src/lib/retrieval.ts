/**
 * Hybrid page retrieval for the chat agent (commit 7).
 *
 * Two retrieval strategies auto-selected by wiki size:
 *
 * Index-first (small wikis, estimated tokens < INDEX_TOKEN_THRESHOLD):
 *   1. Send full page index to POST /chat/select-pages (LLM picks relevant pages)
 *   2. Fetch each page's content via POST /storage/read-page
 *   3. Return RetrievedPage[] with retrieval_method='index'
 *
 * Hybrid (large wikis):
 *   1. FTS5 keyword search via searchPages()
 *   2. Vector similarity via POST /vectors/search
 *   3. Merge + score: FTS×0.35 + vector×0.35 + source_count×0.15 + recency×0.15
 *   4. Take top maxPages, fetch full content via POST /storage/read-page
 *   5. Return RetrievedPage[] with retrieval_method='hybrid'
 *
 * Architecture rule #3: LLM calls (select-pages) go through nlp-service,
 * never directly from Next.js.
 */

import { getAllArchivedPageIds, getPage, getPageIndex, searchPages } from '@/lib/db';
import type { RetrievedPage } from '@/lib/chat-types';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

// Switch to hybrid when the index would exceed ~6000 estimated tokens.
const INDEX_TOKEN_THRESHOLD = 6000;
// Truncate page content before sending to LLM (~2000 tokens).
const MAX_PAGE_CONTENT_CHARS = 8000;

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function fetchPageContent(pageId: string): Promise<string | null> {
  try {
    const res = await fetch(`${NLP_SERVICE_URL}/storage/read-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_id: pageId }),
      signal: AbortSignal.timeout(10_000),
    });
    if (!res.ok) return null;
    const data = (await res.json()) as { content: string; exists: boolean };
    return data.exists ? data.content : null;
  } catch {
    return null;
  }
}

async function fetchIndexPages(pageIds: string[]): Promise<RetrievedPage[]> {
  const results: RetrievedPage[] = [];
  for (const pageId of pageIds) {
    const row = getPage(pageId);
    if (!row) continue;
    const content = await fetchPageContent(pageId);
    if (content == null) continue;
    results.push({
      page_id: pageId,
      title: row.title,
      page_type: row.page_type,
      content: content.slice(0, MAX_PAGE_CONTENT_CHARS),
      score: 1.0,
      retrieval_method: 'index',
    });
  }
  return results;
}

async function indexFirstRetrieval(
  question: string,
  index: ReturnType<typeof getPageIndex>,
  maxPages: number,
): Promise<RetrievedPage[]> {
  // Ask LLM to pick the most relevant page IDs from the full index.
  const res = await fetch(`${NLP_SERVICE_URL}/chat/select-pages`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ question, index }),
    signal: AbortSignal.timeout(30_000),
  });
  // If LLM call failed, fall back to top pages by source_count from the index.
  if (!res.ok) {
    const fallbackIds = index.slice(0, maxPages).map((p) => p.page_id);
    return fetchIndexPages(fallbackIds);
  }

  const data = (await res.json()) as { page_ids: string[] };
  let pageIds = (data.page_ids ?? []).slice(0, maxPages);

  // If LLM returned no page_ids (meta question, empty response), fall back to
  // top pages by source_count so the user always gets a grounded answer.
  if (pageIds.length === 0 && index.length > 0) {
    pageIds = index.slice(0, Math.min(maxPages, 5)).map((p) => p.page_id);
  }

  return fetchIndexPages(pageIds);
}

async function hybridRetrieval(
  question: string,
  maxPages: number,
): Promise<RetrievedPage[]> {
  const fetchCount = maxPages * 2;

  // Compute once — pages where ALL backing sources are archived are excluded
  // from both FTS and vector branches so they never surface in chat.
  const archivedPageIds = getAllArchivedPageIds();

  // FTS5 search (synchronous, already available)
  const ftsRows = searchPages(question, fetchCount, archivedPageIds);

  // Vector search (async, NLP service)
  let vectorMatches: Array<{ page_id: string; similarity: number }> = [];
  try {
    const res = await fetch(`${NLP_SERVICE_URL}/vectors/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query_text: question, n_results: fetchCount }),
      signal: AbortSignal.timeout(15_000),
    });
    if (res.ok) {
      const data = (await res.json()) as {
        matches: Array<{ page_id: string; similarity: number }>;
      };
      // Filter out all-archived pages from vector results
      vectorMatches = (data.matches ?? []).filter(
        (m) => !archivedPageIds.has(m.page_id)
      );
    }
  } catch {
    // Vector branch optional — FTS covers the rest
  }

  // Merge candidates by page_id
  const candidateMap = new Map<
    string,
    { fts_rank: number | null; vec_sim: number | null }
  >();

  ftsRows.forEach((row, idx) => {
    candidateMap.set(row.page_id, { fts_rank: idx, vec_sim: null });
  });
  vectorMatches.forEach((m) => {
    const existing = candidateMap.get(m.page_id);
    if (existing) {
      existing.vec_sim = m.similarity;
    } else {
      candidateMap.set(m.page_id, { fts_rank: null, vec_sim: m.similarity });
    }
  });

  // Normalise FTS ranks (lower rank index = higher relevance → invert)
  const ftsTotal = ftsRows.length;
  const maxSourceCount = Math.max(
    1,
    ...ftsRows.map((r) => r.source_count ?? 0),
  );

  // Score each candidate
  const scored: Array<{ page_id: string; score: number }> = [];
  for (const [pageId, { fts_rank, vec_sim }] of candidateMap) {
    const row = getPage(pageId);
    if (!row) continue;

    const ftsScore =
      fts_rank != null && ftsTotal > 0
        ? 1.0 - fts_rank / ftsTotal
        : 0.0;
    const vecScore = vec_sim ?? 0.0;
    const sourceCountNorm = (row.source_count ?? 0) / maxSourceCount;

    // Recency: days since last_updated (capped at 365)
    const daysSince = Math.min(
      365,
      (Date.now() - new Date(row.last_updated).getTime()) / 86_400_000,
    );
    const recencyNorm = 1.0 - daysSince / 365;

    const score =
      ftsScore * 0.35 +
      vecScore * 0.35 +
      sourceCountNorm * 0.15 +
      recencyNorm * 0.15;

    scored.push({ page_id: pageId, score });
  }

  scored.sort((a, b) => b.score - a.score);
  let topCandidates = scored.slice(0, maxPages);

  // Fallback: if both FTS and vector returned nothing, use top pages by source_count
  // from the full index so the user always gets a grounded answer.
  if (topCandidates.length === 0) {
    const index = getPageIndex();
    topCandidates = index.slice(0, Math.min(maxPages, 5)).map((p) => ({
      page_id: p.page_id,
      score: 0,
    }));
  }

  // Fetch full content for top candidates
  const results: RetrievedPage[] = [];
  for (const { page_id, score } of topCandidates) {
    const row = getPage(page_id);
    if (!row) continue;
    const content = await fetchPageContent(page_id);
    if (content == null) continue;
    results.push({
      page_id,
      title: row.title,
      page_type: row.page_type,
      content: content.slice(0, MAX_PAGE_CONTENT_CHARS),
      score,
      retrieval_method: 'hybrid',
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve the most relevant wiki pages for a question.
 *
 * Auto-selects index-first (small wikis) or hybrid (large wikis) strategy.
 * Returns up to maxPages RetrievedPage objects with content pre-fetched.
 */
export async function retrievePages(
  question: string,
  maxPages = 10,
): Promise<RetrievedPage[]> {
  const index = getPageIndex();
  if (index.length === 0) return [];

  // Estimate how many tokens the index would consume (~4 chars/token)
  const estimatedTokens = index.reduce(
    (sum, p) =>
      sum + (p.title.length + (p.summary?.length ?? 0)) / 4,
    0,
  );

  if (estimatedTokens < INDEX_TOKEN_THRESHOLD) {
    return indexFirstRetrieval(question, index, maxPages);
  }
  return hybridRetrieval(question, maxPages);
}
