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

async function reconcilePendingFlushes(): Promise<void> {
  // Guard here (in addition to register()) so Turbopack's edge-bundle static
  // analysis can dead-code-eliminate the dynamic import below and suppress the
  // node-module-in-edge-runtime warnings for node:crypto/fs/path/zlib in db.ts.
  if (process.env.NEXT_RUNTIME === 'edge') return;

  // Dynamically import so the modules only resolve in Node runtime.
  // flushPendingPage lives in src/lib/flush-pending.ts — shared with the
  // commit route's post-loop durability pass.
  const { getPendingFlushPages, clearPendingContent } = await import('./src/lib/db');
  const { flushPendingPage } = await import('./src/lib/flush-pending');

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
