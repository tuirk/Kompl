/**
 * Page search over the vector index: Chroma in nlp-service, queried through
 * POST /vectors/search. The embedding model runs locally — no LLM call.
 * Used by the related-pages panel and by hybrid search.
 *
 * Never throws: a failed or slow search comes back as `{ ok: false }` so each
 * caller decides how to degrade.
 */

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

export interface VectorMatch {
  page_id: string;
  /** Cosine similarity, 0–1. */
  similarity: number;
}

export type VectorSearchResult =
  | { ok: true; matches: VectorMatch[] }
  | { ok: false; detail: { status: number } | { error: string } };

export async function searchPageVectors(
  queryText: string,
  nResults: number,
  timeoutMs: number
): Promise<VectorSearchResult> {
  try {
    const res = await fetch(`${NLP_SERVICE_URL}/vectors/search`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query_text: queryText, n_results: nResults }),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) return { ok: false, detail: { status: res.status } };
    const data = (await res.json()) as { matches: VectorMatch[] };
    return { ok: true, matches: data.matches };
  } catch (err) {
    return { ok: false, detail: { error: err instanceof Error ? err.message : String(err) } };
  }
}
