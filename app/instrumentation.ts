/**
 * Next.js instrumentation hook — runs once at server startup before any
 * request is handled. Used as a boot-time reconciler for the pending_content
 * outbox: any page row where pending_content IS NOT NULL means the DB
 * committed but the .md.gz file was never successfully written (crash in
 * Phase 3a, or server restarted mid-flush). We re-attempt the write here.
 *
 * Lives at app/instrumentation.ts (Next.js 14+ project root, not src/).
 * Edge runtime guard is mandatory — this file is evaluated in both runtimes
 * during build/dev; `getPendingFlushPages` opens SQLite which is Node-only.
 */

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

type FlushResult = { ok: true; previousPath: string | null } | { ok: false };

async function flushPendingPage(
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
          event: 'reconciler_flush_http_error',
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
        event: 'reconciler_flush_error',
        page_id: pageId,
        error: msg,
      })
    );
    return { ok: false };
  }
}

async function reconcilePendingFlushes(): Promise<void> {
  // Dynamically import so the module only resolves in Node runtime.
  const { getPendingFlushPages, clearPendingContent } = await import('./src/lib/db');

  const pending = getPendingFlushPages();
  if (pending.length === 0) return;

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'reconciler_start',
      count: pending.length,
    })
  );

  let flushed = 0;
  let failed = 0;

  for (const row of pending) {
    const result = await flushPendingPage(row.page_id, row.pending_content);
    if (result.ok) {
      clearPendingContent(row.page_id, result.previousPath);
      flushed++;
    } else {
      failed++;
    }
  }

  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'reconciler_done',
      flushed,
      failed,
    })
  );
}

export async function register(): Promise<void> {
  // Skip in Edge runtime — SQLite is Node-only.
  if (process.env.NEXT_RUNTIME === 'edge') return;

  try {
    await reconcilePendingFlushes();
  } catch (err) {
    // Non-fatal: server still starts, pages will be readable via pending_content fallback.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'reconciler_fatal',
        error: msg,
      })
    );
  }
}
