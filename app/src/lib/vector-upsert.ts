/**
 * Shared vector-upsert helper used by both the compile commit route and the
 * manual draft-approve route. Up to 3 attempts with 500ms backoff. On final
 * failure the page_id is queued in vector_backfill_queue so it can be
 * recovered via POST /api/compile/backfill-vectors without re-compiling.
 * Never throws — vector failures must not fail the caller's response.
 */

import { getDb } from './db';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

export async function upsertVectorWithRetry(
  page_id: string,
  metadata: Record<string, unknown>,
  retries = 3
): Promise<void> {
  const db = getDb();
  const payload = JSON.stringify({ page_id, metadata });
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const res = await fetch(`${NLP_SERVICE_URL}/vectors/upsert`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: payload,
        signal: AbortSignal.timeout(30_000),
      });
      if (res.ok) return;
      throw new Error(`status ${res.status}`);
    } catch (err) {
      if (attempt < retries - 1) {
        await new Promise((r) => setTimeout(r, 500));
      } else {
        console.error(
          JSON.stringify({
            ts: new Date().toISOString(),
            event: 'vector_upsert_failed',
            page_id,
            error: err instanceof Error ? err.message : String(err),
          })
        );
        try {
          db.prepare('INSERT OR IGNORE INTO vector_backfill_queue (page_id) VALUES (?)').run(page_id);
        } catch {
          /* non-fatal */
        }
      }
    }
  }
}
