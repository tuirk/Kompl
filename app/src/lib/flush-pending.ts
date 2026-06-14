/**
 * Phase 3a flush helper — POST /storage/write-page for a single page.
 *
 * Shared by:
 *   - the boot reconciler (app/instrumentation.ts), which re-flushes any
 *     page where pending_content IS NOT NULL after a crash mid-Phase-3a
 *   - the commit route's post-loop durability pass
 *     (app/api/compile/commit/route.ts), which re-attempts stranded
 *     flushes so /api/compile/retry can recover without a server restart
 *
 * Never throws — failures are logged and reported as { ok: false } so the
 * caller decides whether to fail the session or leave the row for the
 * next reconcile pass. Deliberately does NOT import db.ts: callers own
 * the clearPendingContent() call, and keeping this module Node-API-free
 * lets instrumentation.ts import it without edge-runtime guards.
 */

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

export type FlushResult = { ok: true; previousPath: string | null } | { ok: false };

export async function flushPendingPage(
  pageId: string,
  markdown: string
): Promise<FlushResult> {
  try {
    const res = await fetch(`${NLP_SERVICE_URL}/storage/write-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ page_id: pageId, markdown }),
      signal: AbortSignal.timeout(30_000),
    });
    if (!res.ok) {
      console.error(
        JSON.stringify({
          ts: new Date().toISOString(),
          event: 'flush_pending_http_error',
          page_id: pageId,
          status: res.status,
        })
      );
      return { ok: false };
    }
    const body = (await res.json()) as { current_path: string; previous_path: string | null };
    return { ok: true, previousPath: body.previous_path };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'flush_pending_error',
        page_id: pageId,
        error: msg,
      })
    );
    return { ok: false };
  }
}
