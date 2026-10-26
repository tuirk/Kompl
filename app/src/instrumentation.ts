/**
 * Next.js instrumentation hook — runs once at server startup before any
 * request is handled. Used as a boot-time reconciler for the pending_content
 * outbox: any page row where pending_content IS NOT NULL means the DB
 * committed but the .md.gz file was never successfully written (crash in
 * Phase 3a, or server restarted mid-flush). We re-attempt the write here.
 *
 * Lives at app/src/instrumentation.ts: Next.js only loads the hook from the
 * project root when there is no src/ folder. It sat at app/instrumentation.ts
 * from April to October 2026 and never ran in any build.
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
  const { getPage, getPendingFlushPages, clearPendingContent } = await import('./lib/db');
  const { flushPendingPage } = await import('./lib/flush-pending');
  const { upsertVectorWithRetry } = await import('./lib/vector-upsert');

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
      // The commit's own vector refresh needs the file on disk, so it was
      // skipped or embedded the old text; refresh it now (Saved Links has no
      // vector). Never throws.
      const page = getPage(row.page_id);
      if (page && page.page_id !== 'saved-links') {
        void upsertVectorWithRetry(page.page_id, {
          title: page.title,
          page_type: page.page_type,
          category: page.category ?? '',
          source_count: page.source_count,
        });
      }
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

/**
 * Re-derive every page's wikilink rows once per link-parser version. Before
 * version 1 the parser read [[Target|label]] as a link to a page titled
 * "Target|label", so those links were missing from page_links (backlinks,
 * graph). Page text is not touched. Bump WIKILINKS_RESYNC_VERSION whenever
 * the parser in src/lib/wikilink-syntax.ts changes what it resolves.
 */
const WIKILINKS_RESYNC_VERSION = '1';

async function resyncWikilinksOnce(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'edge') return;

  const { getDb, getSetting, setSetting } = await import('./lib/db');
  if (getSetting('wikilinks_resync_version') === WIKILINKS_RESYNC_VERSION) return;

  const { resyncAllWikilinks } = await import('./lib/wikilinks');
  const result = resyncAllWikilinks(getDb());
  setSetting('wikilinks_resync_version', WIKILINKS_RESYNC_VERSION);
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'wikilinks_resync_done',
      version: WIKILINKS_RESYNC_VERSION,
      ...result,
    })
  );
}

/**
 * Fill relationship_mentions.description (schema v28) once from the stored
 * extractions, so relations extracted before v28 show the LLM's sentence as
 * well. No LLM calls; only rows still NULL are written. Bump
 * RELATION_BACKFILL_VERSION when src/lib/relation-backfill.ts learns to
 * match rows it used to miss.
 */
const RELATION_BACKFILL_VERSION = '1';

async function backfillRelationsOnce(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'edge') return;

  const { getDb, getSetting, setSetting } = await import('./lib/db');
  if (getSetting('relation_descriptions_backfill_version') === RELATION_BACKFILL_VERSION) return;

  const { backfillRelationDescriptions } = await import('./lib/relation-backfill');
  const result = backfillRelationDescriptions(getDb());
  setSetting('relation_descriptions_backfill_version', RELATION_BACKFILL_VERSION);
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'relation_descriptions_backfill_done',
      version: RELATION_BACKFILL_VERSION,
      ...result,
    })
  );
}

/**
 * Fill the disagreements record (plan 3.4) once from what the wiki already
 * holds: the Disputed/Changed sections in every page's text (pages
 * committed before 1ff33db3 never logged theirs) and the triage verdicts in
 * the activity log. No LLM calls (lib/disagreement-backfill.ts).
 */
async function backfillDisagreementsOnce(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'edge') return;

  const { getDb, getSetting, setSetting } = await import('./lib/db');
  const { backfillDisagreements, DISAGREEMENTS_BACKFILL_KEY, DISAGREEMENTS_BACKFILL_VERSION } = await import(
    './lib/disagreement-backfill'
  );
  if (getSetting(DISAGREEMENTS_BACKFILL_KEY) === DISAGREEMENTS_BACKFILL_VERSION) return;

  const result = backfillDisagreements(getDb());
  setSetting(DISAGREEMENTS_BACKFILL_KEY, DISAGREEMENTS_BACKFILL_VERSION);
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'disagreements_backfill_done',
      version: DISAGREEMENTS_BACKFILL_VERSION,
      ...result,
    })
  );
}

/**
 * Date the sources added before Kompl kept publication dates (plan 3.2),
 * once, from their stored text and metadata; no LLM calls, no fetches
 * (lib/source-date-backfill.ts). A date already set is never overwritten,
 * except one read from the text, which a new version reads again.
 */
async function backfillSourceDatesAtBoot(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'edge') return;

  const { getDb } = await import('./lib/db');
  const { backfillSourceDatesOnce, SOURCE_DATES_BACKFILL_VERSION } = await import('./lib/source-date-backfill');
  const result = backfillSourceDatesOnce(getDb());
  if (!result) return;
  console.log(
    JSON.stringify({
      ts: new Date().toISOString(),
      event: 'source_dates_backfill_done',
      version: SOURCE_DATES_BACKFILL_VERSION,
      ...result,
    })
  );
}

/**
 * Set aside stored aliases with a clearly wrong shape (lib/alias-screen.ts).
 * Runs here when it needs no nlp-service call; otherwise in the background
 * once nlp-service answers, so a slow model load never delays boot.
 */
async function screenAliasesAfterBoot(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'edge') return;

  const { getDb } = await import('./lib/db');
  const { screenAliasesNowOrLater } = await import('./lib/alias-screen');
  await screenAliasesNowOrLater(getDb(), 'boot');
}

/**
 * A restart ends any bulk page update (its state lived in the old process),
 * so its CLAUDE.md rule-7 flag goes back to off; the next run needs a new
 * confirmation in Settings > Wiki health (lib/page-upgrade.ts).
 */
async function disarmPageUpgrade(): Promise<void> {
  if (process.env.NEXT_RUNTIME === 'edge') return;

  const { getSetting, setSetting } = await import('./lib/db');
  const { PAGE_UPGRADE_FLAG } = await import('./lib/page-upgrade-state');
  if (getSetting(PAGE_UPGRADE_FLAG) === '1') setSetting(PAGE_UPGRADE_FLAG, '0');
  // The wiki repair likewise: its flag goes off, and a run the old process
  // left going is recorded as stopped by the restart (lib/wiki-repair/state.ts).
  const { settleAfterRestart } = await import('./lib/wiki-repair/state');
  settleAfterRestart();
}

export async function register(): Promise<void> {
  // Skip in Edge runtime — SQLite is Node-only.
  if (process.env.NEXT_RUNTIME === 'edge') return;

  try {
    await disarmPageUpgrade();
  } catch (err) {
    // Non-fatal: the flag only lets a confirmed run start, and only a new
    // confirmation (which sets it again) starts one.
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'page_upgrade_disarm_failed',
        error: err instanceof Error ? err.message : String(err),
      })
    );
  }

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

  try {
    // After the reconciler, so pages flushed from pending_content are read
    // from their final files.
    await resyncWikilinksOnce();
  } catch (err) {
    // Non-fatal: links keep their previous rows; the next boot retries.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'wikilinks_resync_failed',
        error: msg,
      })
    );
  }

  try {
    await backfillRelationsOnce();
  } catch (err) {
    // Non-fatal: relations show without their sentence; the next boot retries.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'relation_descriptions_backfill_failed',
        error: msg,
      })
    );
  }

  try {
    // After the reconciler, so pages flushed from pending_content are read
    // from their final files.
    await backfillDisagreementsOnce();
  } catch (err) {
    // Non-fatal: the panel still reads each page's text; the next boot retries.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'disagreements_backfill_failed',
        error: msg,
      })
    );
  }

  try {
    await backfillSourceDatesAtBoot();
  } catch (err) {
    // Non-fatal: undated sources read as the day they were added; the next
    // boot retries.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'source_dates_backfill_failed',
        error: msg,
      })
    );
  }

  try {
    await screenAliasesAfterBoot();
  } catch (err) {
    // Non-fatal: aliases keep their status; the next boot or import retries.
    const msg = err instanceof Error ? err.message : String(err);
    console.error(
      JSON.stringify({
        ts: new Date().toISOString(),
        event: 'alias_screen_failed',
        error: msg,
      })
    );
  }
}
