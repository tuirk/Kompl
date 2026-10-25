export const dynamic = 'force-dynamic';

import JSZip from 'jszip';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { NextResponse } from 'next/server';

import { getDb, DATA_ROOT, getDailyCapUsd, logActivity, safePreviousContentPath, setDailyCapUsd } from '@/lib/db';
import { aliasRecordFromBackup } from '@/lib/alias-records';
import { referenceCheck, type SkippedRows } from '@/lib/backup-references';
import { screenAliasesNowOrLater } from '@/lib/alias-screen';
import {
  compileModelFromBackup,
  failureAttemptsFromBackup,
  restorePageTypeFromBackup,
  sourceCompileStateFromBackup,
  textOrNull,
  usedSourceIdsFromBackup,
} from '@/lib/backup-columns';
import { isBackedUpSetting } from '@/lib/backup-settings';
import { sanitizeDraftRules } from '@/lib/draft-rules';
import { backfillDisagreements, importDisagreements } from '@/lib/disagreement-backfill';
import { importClaimVerdicts } from '@/lib/claim-check/verdicts';
import { backfillRelationDescriptions } from '@/lib/relation-backfill';
import { backfillSourceDates } from '@/lib/source-date-backfill';
import {
  cleanRelationDescription,
  cleanRelationQuote,
  quoteVerifiedColumn,
  quoteVerifiedFromColumn,
} from '@/lib/relation-rows';
import { isSafeId } from '@/lib/safe-paths';
import { resyncAllWikilinks } from '@/lib/wikilinks';
import { countUserPages, SYSTEM_PAGE_IDS } from '@/lib/wiki-empty';


export async function POST(request: Request) {
  // Parse multipart
  let form: FormData;
  try {
    form = await request.formData();
  } catch {
    return NextResponse.json({ error: 'invalid_multipart' }, { status: 400 });
  }

  const file = form.get('file');
  if (!(file instanceof File)) {
    return NextResponse.json({ error: 'no file' }, { status: 422 });
  }

  // Load zip
  let zip: JSZip;
  try {
    zip = await JSZip.loadAsync(await file.arrayBuffer());
  } catch {
    return NextResponse.json({ error: 'invalid_zip' }, { status: 422 });
  }

  // Validate manifest
  const manifestRaw = await zip.file('manifest.json')?.async('string');
  if (!manifestRaw) {
    return NextResponse.json({ error: 'invalid_format: no manifest' }, { status: 422 });
  }
  let manifest: { format: string; version: number; schema_version?: number };
  try {
    manifest = JSON.parse(manifestRaw) as { format: string; version: number; schema_version?: number };
  } catch {
    return NextResponse.json({ error: 'invalid_manifest' }, { status: 422 });
  }
  if (manifest.format !== 'kompl') {
    return NextResponse.json({ error: 'invalid_format' }, { status: 422 });
  }

  // Check empty-wiki precondition (v1: clean import only).
  // System-generated pages (e.g. saved-links) are ignored — they'd otherwise
  // block import on a wiki that the user considers empty.
  const db = getDb();
  const userPageCount = countUserPages();
  if (userPageCount > 0) {
    return NextResponse.json(
      {
        error: 'wiki_not_empty',
        message: 'Import only works on a new, empty Kompl with nothing compiled yet; this wiki already has pages.',
        existing_pages: userPageCount,
      },
      { status: 409 }
    );
  }

  // -------------------------------------------------------------------------
  // Phase 1 (async): Pre-read all zip content into memory
  // -------------------------------------------------------------------------

  const sources = JSON.parse((await zip.file('db/sources.json')?.async('string')) ?? '[]') as Record<string, unknown>[];
  const pages   = JSON.parse((await zip.file('db/pages.json')?.async('string')) ?? '[]') as Record<string, unknown>[];
  const provenance  = JSON.parse((await zip.file('db/provenance.json')?.async('string')) ?? '[]') as Record<string, unknown>[];
  const aliases     = JSON.parse((await zip.file('db/aliases.json')?.async('string')) ?? '[]') as Record<string, unknown>[];
  const extractions = JSON.parse((await zip.file('db/extractions.json')?.async('string')) ?? '[]') as Record<string, unknown>[];
  const pageLinks            = JSON.parse((await zip.file('db/page_links.json')?.async('string')) ?? '[]') as Record<string, unknown>[];
  const entityMentions       = JSON.parse((await zip.file('db/entity_mentions.json')?.async('string')) ?? '[]') as Record<string, unknown>[];
  const relationshipMentions = JSON.parse((await zip.file('db/relationship_mentions.json')?.async('string')) ?? '[]') as Record<string, unknown>[];
  const drafts               = JSON.parse((await zip.file('db/drafts.json')?.async('string')) ?? '[]') as Record<string, unknown>[];
  const activityLog          = JSON.parse((await zip.file('db/activity_log.json')?.async('string')) ?? '[]') as Record<string, unknown>[];
  const compileProgress      = JSON.parse((await zip.file('db/compile_progress.json')?.async('string')) ?? '[]') as Record<string, unknown>[];
  const chatMessages         = JSON.parse((await zip.file('db/chat_messages.json')?.async('string')) ?? '[]') as Record<string, unknown>[];
  const pagePlans            = JSON.parse((await zip.file('db/page_plans.json')?.async('string')) ?? '[]') as Record<string, unknown>[];
  const disagreements        = JSON.parse((await zip.file('db/disagreements.json')?.async('string')) ?? '[]') as unknown[];
  const claimVerdicts        = JSON.parse((await zip.file('db/claim_verdicts.json')?.async('string')) ?? '[]') as unknown[];
  const ingestFailures       = JSON.parse((await zip.file('db/ingest_failures.json')?.async('string')) ?? '[]') as Record<string, unknown>[];
  const settings    = JSON.parse((await zip.file('db/settings.json')?.async('string')) ?? '[]') as Record<string, string>[];
  const schemaContent = (await zip.file('schema.md')?.async('string')) ?? null;

  // Validate ids before any write. page_id/source_id flow into file paths
  // and routes (readPageMarkdown asserts and THROWS on bad ids — a row with
  // page_id '../../evil' would 500 every /wiki visit), and a crafted zip
  // could smuggle traversal segments. Reject the whole zip on any offender.
  const badIds = [
    ...sources.filter((s) => !isSafeId(s.source_id)).map((s) => `source:${String(s.source_id)}`),
    ...pages.filter((p) => !isSafeId(p.page_id)).map((p) => `page:${String(p.page_id)}`),
  ];
  if (badIds.length > 0) {
    return NextResponse.json(
      {
        error: 'invalid_ids',
        message: 'Import zip contains source/page ids that are not valid Kompl ids.',
        invalid: badIds.slice(0, 20),
      },
      { status: 422 }
    );
  }

  // Pre-read all .gz buffers into Maps (async, before the sync transaction)
  const rawBuffers  = new Map<string, Buffer>();
  const pageBuffers = new Map<string, Buffer>();

  for (const [relPath, entry] of Object.entries(zip.files)) {
    if (entry.dir) continue;
    if (relPath.startsWith('raw/')) {
      rawBuffers.set(path.basename(relPath), Buffer.from(await entry.async('arraybuffer')));
    }
    if (relPath.startsWith('pages/')) {
      pageBuffers.set(path.basename(relPath), Buffer.from(await entry.async('arraybuffer')));
    }
  }

  // -------------------------------------------------------------------------
  // Phase 2 (sync transaction): writeFileSync + all DB inserts
  // Follows the storeRawMarkdown pattern — file writes are atomic with DB rows.
  // -------------------------------------------------------------------------

  // Remove stale on-disk system pages so a zip without one doesn't leave
  // orphan .md.gz files behind. DB rows are deleted inside the transaction.
  for (const pid of SYSTEM_PAGE_IDS) {
    const stalePath = path.join(DATA_ROOT, 'pages', `${pid}.md.gz`);
    try { fs.unlinkSync(stalePath); } catch { /* missing is fine */ }
  }

  // Rows naming a source or page the backup lacks (backups made before
  // every source and page went in) are left out and reported, not fatal;
  // the transaction returns what it left out.
  const restore = db.transaction((): SkippedRows => {
    fs.mkdirSync(path.join(DATA_ROOT, 'raw'), { recursive: true });
    fs.mkdirSync(path.join(DATA_ROOT, 'pages'), { recursive: true });

    // Wipe system-generated state (saved-links page + ingest_failures) so
    // the incoming zip inserts cleanly. The emptiness check above guarantees
    // no user pages exist, so this touches only auto-generated rows.
    for (const pid of SYSTEM_PAGE_IDS) {
      db.prepare('DELETE FROM page_links WHERE source_page_id = ? OR target_page_id = ?').run(pid, pid);
      db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(pid);
      db.prepare('DELETE FROM pages WHERE page_id = ?').run(pid);
    }
    db.prepare('DELETE FROM ingest_failures').run();

    for (const [filename, buf] of rawBuffers) {
      fs.writeFileSync(path.join(DATA_ROOT, 'raw', filename), buf);
    }
    for (const [filename, buf] of pageBuffers) {
      fs.writeFileSync(path.join(DATA_ROOT, 'pages', filename), buf);
    }
    if (schemaContent) {
      fs.writeFileSync(path.join(DATA_ROOT, 'schema.md'), schemaContent);
    }

    for (const s of sources) {
      // published_at / published_at_source exist from the v30 step; older
      // backups import NULL, read as the day the source was added.
      const published = typeof s.published_at === 'string' && typeof s.published_at_source === 'string';
      // title_source / title_rescued_at (v25) keep a recompile from renaming
      // a source whose title the owner gave or one already rescued; older
      // backups import NULL, as sources ingested before v25 have.
      // The compile state and session come back as they were (a failed
      // source can be retried, a session lists its sources); backups without
      // them restore the source as compiled, with no session.
      const state = sourceCompileStateFromBackup(s);
      db.prepare(
        `INSERT OR IGNORE INTO sources
           (source_id, title, source_type, source_url, content_hash, file_path,
            status, date_ingested, metadata, compile_status, compile_attempts,
            compile_next_eligible_at, onboarding_session_id,
            published_at, published_at_source, title_source, title_rescued_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        s.source_id as string,
        s.title as string,
        s.source_type as string,
        (s.source_url as string | null) ?? null,
        s.content_hash as string,
        s.file_path as string,
        (s.status as string | null) ?? 'active',
        s.date_ingested as string,
        (s.metadata as string | null) ?? null,
        state.compile_status,
        state.compile_attempts,
        state.compile_next_eligible_at,
        state.onboarding_session_id,
        published ? (s.published_at as string) : null,
        published ? (s.published_at_source as string) : null,
        textOrNull(s.title_source),
        textOrNull(s.title_rescued_at)
      );
    }

    for (const p of pages) {
      // draft_rules exists from schema v27. Older backups don't carry it and
      // import as NULL: "written by an earlier version", offered for an update.
      // restore_page_type / archive_reason (v30, lib/page-hold.ts): a page
      // archived after a failed rewrite; older backups import it as archived.
      db.prepare(
        `INSERT OR IGNORE INTO pages
           (page_id, title, page_type, category, summary, content_path,
            previous_content_path, last_updated, source_count, created_at,
            draft_rules, restore_page_type, archive_reason)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        p.page_id as string,
        p.title as string,
        p.page_type as string,
        (p.category as string | null) ?? null,
        (p.summary as string | null) ?? null,
        p.content_path as string,
        // Untrusted column from the zip: only /data/pages archives of this
        // page_id survive; anything else (e.g. /data/db/kompl.db) is nulled
        // so the previous-version route can never read outside PAGES_DIR.
        safePreviousContentPath(p.page_id as string, (p.previous_content_path as string | null) ?? null),
        p.last_updated as string,
        (p.source_count as number | null) ?? 0,
        p.created_at as string,
        sanitizeDraftRules(p.draft_rules),
        restorePageTypeFromBackup(p.restore_page_type),
        textOrNull(p.archive_reason)
      );

      // Decompress synchronously for FTS5 — buffer already in memory from Phase 1
      const buf = pageBuffers.get(`${p.page_id as string}.md.gz`);
      let content = (p.summary as string | null) ?? '';
      if (buf) {
        try {
          content = zlib.gunzipSync(buf).toString('utf-8');
        } catch { /* fallback to summary */ }
      }
      db.prepare('INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)').run(
        p.page_id as string,
        p.title as string,
        content
      );
    }

    const refs = referenceCheck(db);

    for (const pr of provenance) {
      if (!refs.keep('provenance', { sources: [pr.source_id], pages: [pr.page_id] })) continue;
      db.prepare(
        `INSERT OR IGNORE INTO provenance
           (source_id, page_id, content_hash, date_compiled, contribution_type)
         VALUES (?, ?, ?, ?, ?)`
      ).run(
        pr.source_id as string,
        pr.page_id as string,
        pr.content_hash as string,
        pr.date_compiled as string,
        pr.contribution_type as string
      );
    }

    for (const raw of aliases) {
      // method, score, session_id and status exist from schema v29; older
      // backups import as active rows with no method (lib/alias-records.ts).
      const a = aliasRecordFromBackup(raw);
      if (!refs.keep('aliases', { pages: [a.canonical_page_id] })) continue;
      db.prepare(
        `INSERT OR IGNORE INTO aliases
           (alias, canonical_name, canonical_page_id, method, score, session_id,
            status, status_reason, status_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP))`
      ).run(
        a.alias,
        a.canonical_name,
        a.canonical_page_id,
        a.method,
        a.score,
        a.session_id,
        a.status,
        a.status_reason,
        a.status_at,
        a.created_at
      );
    }

    for (const e of extractions) {
      if (!refs.keep('extractions', { sources: [e.source_id] })) continue;
      db.prepare(
        `INSERT OR IGNORE INTO extractions
           (source_id, ner_output, profile, keyphrase_output, tfidf_output, llm_output, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        e.source_id as string,
        (e.ner_output as string | null) ?? null,
        (e.profile as string | null) ?? null,
        (e.keyphrase_output as string | null) ?? null,
        (e.tfidf_output as string | null) ?? null,
        (e.llm_output as string | null) ?? null,
        e.created_at as string
      );
    }

    for (const l of pageLinks) {
      if (!refs.keep('page_links', { pages: [l.source_page_id, l.target_page_id] })) continue;
      db.prepare(
        `INSERT OR IGNORE INTO page_links
           (source_page_id, target_page_id, link_type, created_at)
         VALUES (?, ?, ?, ?)`
      ).run(
        l.source_page_id as string,
        l.target_page_id as string,
        l.link_type as string,
        l.created_at as string
      );
    }

    for (const m of entityMentions) {
      if (!refs.keep('entity_mentions', { sources: [m.source_id] })) continue;
      db.prepare(
        `INSERT OR IGNORE INTO entity_mentions
           (canonical_name, source_id, entity_type, first_seen_at)
         VALUES (?, ?, ?, ?)`
      ).run(
        m.canonical_name as string,
        m.source_id as string,
        (m.entity_type as string | null) ?? null,
        m.first_seen_at as string
      );
    }

    for (const r of relationshipMentions) {
      if (!refs.keep('relationship_mentions', { sources: [r.source_id] })) continue;
      // description exists from schema v28; older backups import it as NULL
      // and the backfill below fills it from the restored extractions.
      // quote and quote_verified exist from v30; older backups import NULL,
      // shown as Kompl's summary like any relation extracted before quotes.
      const quote = cleanRelationQuote(r.quote, quoteVerifiedFromColumn(r.quote_verified as number | null));
      db.prepare(
        `INSERT OR IGNORE INTO relationship_mentions
           (from_canonical, to_canonical, relationship_type, source_id, first_seen_at,
            description, quote, quote_verified)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        r.from_canonical as string,
        r.to_canonical as string,
        r.relationship_type as string,
        r.source_id as string,
        r.first_seen_at as string,
        cleanRelationDescription(r.description),
        quote.quote,
        quoteVerifiedColumn(quote.quote_verified)
      );
    }

    for (const d of drafts) {
      db.prepare(
        `INSERT OR IGNORE INTO drafts
           (draft_id, page_id, draft_content, draft_type, source_id, status, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        d.draft_id as string,
        (d.page_id as string | null) ?? null,
        d.draft_content as string,
        d.draft_type as string,
        (d.source_id as string | null) ?? null,
        (d.status as string | null) ?? 'pending',
        d.created_at as string
      );
    }

    for (const a of activityLog) {
      // session_id / step_key (v23) tie an event to its compile session's
      // progress view; older backups import NULL.
      db.prepare(
        `INSERT INTO activity_log (timestamp, action_type, source_id, details, session_id, step_key)
         VALUES (?, ?, ?, ?, ?, ?)`
      ).run(
        a.timestamp as string,
        a.action_type as string,
        (a.source_id as string | null) ?? null,
        (a.details as string | null) ?? null,
        textOrNull(a.session_id),
        textOrNull(a.step_key)
      );
    }

    for (const cp of compileProgress) {
      // compile_model (v20): the model the session was locked to, so a retry
      // of a restored session compiles with it; older backups import NULL.
      db.prepare(
        `INSERT OR IGNORE INTO compile_progress
           (session_id, status, current_step, steps, error,
            started_at, completed_at, created_at, source_count, compile_model)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        cp.session_id as string,
        cp.status as string,
        (cp.current_step as string | null) ?? null,
        cp.steps as string,
        (cp.error as string | null) ?? null,
        (cp.started_at as string | null) ?? null,
        (cp.completed_at as string | null) ?? null,
        cp.created_at as string,
        (cp.source_count as number | null) ?? 0,
        compileModelFromBackup(cp.compile_model)
      );
    }

    for (const cm of chatMessages) {
      db.prepare(
        `INSERT INTO chat_messages
           (session_id, role, content, citations, pages_used, chat_model, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`
      ).run(
        cm.session_id as string,
        cm.role as string,
        cm.content as string,
        (cm.citations as string | null) ?? null,
        (cm.pages_used as string | null) ?? null,
        (cm.chat_model as string | null) ?? null,
        cm.created_at as string
      );
    }

    // The links the owner saved that could not be fetched, which the
    // restored Saved Links page lists; backups made before they were
    // carried have none, and the page then empties at its next rebuild.
    for (const f of ingestFailures) {
      db.prepare(
        `INSERT OR IGNORE INTO ingest_failures
           (failure_id, source_url, title_hint, date_saved, date_attempted, error,
            source_type, resolved_source_id, metadata, session_id, attempts)
         VALUES (?, ?, ?, ?, COALESCE(?, CURRENT_TIMESTAMP), ?, COALESCE(?, 'url'), ?, ?, ?, ?)`
      ).run(
        f.failure_id as string,
        textOrNull(f.source_url),
        textOrNull(f.title_hint),
        textOrNull(f.date_saved),
        textOrNull(f.date_attempted),
        f.error as string,
        textOrNull(f.source_type),
        textOrNull(f.resolved_source_id),
        textOrNull(f.metadata),
        textOrNull(f.session_id),
        failureAttemptsFromBackup(f.attempts)
      );
    }

    for (const pp of pagePlans) {
      // draft_rules (v27): older backups import as NULL, so a pre-v0.4 draft
      // still waiting for approval never marks its page as current.
      // used_source_ids (v30) keeps approval crediting only the sources the
      // draft read; NULL (older backups) credits every plan source.
      db.prepare(
        `INSERT OR IGNORE INTO page_plans
           (plan_id, session_id, title, page_type, action,
            source_ids, existing_page_id, related_plan_ids,
            draft_content, draft_status, created_at, draft_rules,
            draft_error, used_source_ids)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        pp.plan_id as string,
        pp.session_id as string,
        pp.title as string,
        pp.page_type as string,
        (pp.action as string | null) ?? 'create',
        pp.source_ids as string,
        (pp.existing_page_id as string | null) ?? null,
        (pp.related_plan_ids as string | null) ?? null,
        (pp.draft_content as string | null) ?? null,
        (pp.draft_status as string | null) ?? 'planned',
        pp.created_at as string,
        sanitizeDraftRules(pp.draft_rules),
        textOrNull(pp.draft_error),
        usedSourceIdsFromBackup(pp.used_source_ids)
      );
    }

    // The disagreements record (v30), owner verdicts included; backups from
    // before it carry none and are filled below from their pages.
    const disagreementRows = Array.isArray(disagreements) ? disagreements : [];
    refs.leftOut('disagreements', disagreementRows.length - importDisagreements(db, disagreementRows));
    // The claim check's saved verdicts (v30); older backups carry none.
    const verdictRows = Array.isArray(claimVerdicts) ? claimVerdicts : [];
    refs.leftOut('claim_verdicts', verdictRows.length - importClaimVerdicts(db, verdictRows));

    for (const s of settings) {
      // schema_version, the page-update flag and the agent-sources switch
      // belong to this install, not to the backup (lib/backup-settings.ts).
      if (!isBackedUpSetting(s.key)) continue;
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(s.key, s.value);
    }

    // Backups taken before schema v26 carry no compile_model row when the
    // user kept the default, and that wiki compiled on gemini-2.5-flash.
    // Pin it so the restored wiki keeps the model (and provider key) it was
    // built with instead of the newer default. Mirrors migrate.py v26.
    const bundleSchemaVersion = typeof manifest.schema_version === 'number' ? manifest.schema_version : 0;
    if (bundleSchemaVersion < 26 && !settings.some((s) => s.key === 'compile_model')) {
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('compile_model', 'gemini-2.5-flash')`).run();
    }

    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarding_completed', '1')`).run();
    return refs.summary();
  });

  // One transaction: a row the restore cannot hold (a broken backup, e.g. an
  // event with no type) restores nothing, and the answer says why instead
  // of an empty server error. Rows an old backup holds for sources or pages
  // it lacks are left out and reported instead (lib/backup-references.ts).
  let leftOut: SkippedRows;
  try {
    leftOut = restore();
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[import] restore failed, nothing was restored:', message);
    return NextResponse.json(
      { error: 'import_failed', message: `The backup could not be restored (${message}). Nothing was restored.` },
      { status: 500 }
    );
  }

  // A restored daily spending cap goes to /data/llm-config.json too, the
  // file nlp-service enforces, so the cap enforced is the one Settings shows.
  if (settings.some((s) => s.key === 'daily_cap_usd')) setDailyCapUsd(getDailyCapUsd());

  // Re-derive wikilink rows from the restored page text with the current
  // parser. A backup's page_links can predate parser fixes (e.g. piped
  // [[Target|label]] links were once dropped); import only runs on an empty
  // wiki, so this touches exactly the restored pages.
  resyncAllWikilinks(db);

  // Relations from a backup older than schema v28 carry no description; fill
  // them from the restored extractions (no LLM calls). Non-fatal: the data
  // is already committed, and the relations still show without a sentence.
  try {
    backfillRelationDescriptions(db);
  } catch (err) {
    console.error('[import] relation description backfill failed:', err instanceof Error ? err.message : err);
  }

  // Disagreements the restored pages record and the triage verdicts in the
  // restored activity log, for what the backup's record lacks (no LLM
  // calls). Non-fatal: the next boot's backfill never re-runs, but each
  // page's next commit syncs it.
  try {
    backfillDisagreements(db);
  } catch (err) {
    console.error('[import] disagreements backfill failed:', err instanceof Error ? err.message : err);
  }

  // Sources from a backup made before publication dates were kept get them
  // from their restored text (no LLM calls); dates the backup carries stay.
  // Non-fatal: undated sources read as the day they were added.
  try {
    backfillSourceDates(db);
  } catch (err) {
    console.error('[import] source dates backfill failed:', err instanceof Error ? err.message : err);
  }

  // -------------------------------------------------------------------------
  // Phase 3: Vector restore or backfill + activity log
  // -------------------------------------------------------------------------

  // If the zip contains pre-computed embeddings, restore them directly
  // (no re-embedding needed). Otherwise, or when they are empty, unreadable
  // or refused, every page is embedded again by the backfill endpoint.
  const vectorsJson = await zip.file('vectors.json')?.async('string');
  const NLP_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';
  const backfillVectors = () =>
    void fetch(`${process.env.APP_URL ?? 'http://app:3000'}/api/compile/backfill-vectors`, {
      method: 'POST',
      signal: AbortSignal.timeout(300_000),
    }).catch(() => {});
  let vectorItems: unknown[] = [];
  try {
    const vData = vectorsJson ? (JSON.parse(vectorsJson) as { items?: unknown }) : null;
    if (vData && Array.isArray(vData.items)) vectorItems = vData.items;
  } catch {
    // unreadable: embed again
  }
  if (vectorItems.length > 0) {
    void fetch(`${NLP_URL}/vectors/restore`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ items: vectorItems }),
      signal: AbortSignal.timeout(120_000),
    })
      .then((res) => {
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
      })
      .catch((e: unknown) => {
        console.error('[import] vectors/restore failed, falling back to backfill:', e instanceof Error ? e.message : e);
        backfillVectors();
      });
  } else {
    backfillVectors();
  }

  logActivity('wiki_imported', {
    source_id: null,
    details: {
      source_count: sources.length,
      page_count: pages.length,
      format_version: manifest.version,
      // What an old backup lacked, so the feed says the restore is partial.
      ...(leftOut.total > 0 ? { skipped_rows: leftOut.total, skipped: leftOut } : {}),
    },
  });

  // Aliases from a backup made before schema v29 come back active with no
  // method; the alias screen looks at every such row and sets aside the
  // clearly wrong ones (in the background when it needs nlp-service).
  // Non-fatal: the next boot looks at them again.
  try {
    await screenAliasesNowOrLater(db, 'import', { force: true });
  } catch (err) {
    console.error('[import] alias screen failed:', err instanceof Error ? err.message : err);
  }

  return NextResponse.json({ imported: true, sources: sources.length, pages: pages.length, skipped: leftOut });
}
