/**
 * The .kompl.zip backup (GET /api/export?format=kompl), the one export
 * POST /api/import can restore: manifest.json, every table the restore
 * reads under db/, raw source text under raw/, page files under pages/,
 * schema.md and, when asked, the vectors.
 *
 * Left out on purpose (the round-trip test lists them too):
 *   triage_rechecks        retry state, not wiki content (lib/triage-rechecks.ts)
 *   vector_backfill_queue  a work queue; the import embeds every page again
 *   collect_staging        temporary items staged for a compile session; what
 *                          they became is in sources, ingest_failures and the
 *                          activity log, which go in
 *   raw/uploads/           uploaded originals; the wiki reads their text,
 *                          kept as each source's raw file, which goes in
 *   install-only settings  lib/backup-settings.ts
 */

import JSZip from 'jszip';
import fs from 'fs/promises';
import path from 'path';
import zlib from 'zlib';

import {
  getAllActivityLog,
  getAllAliases,
  getAllChatMessages,
  getAllCompileProgress,
  getAllDrafts,
  getAllEntityMentions,
  getAllExtractions,
  getAllIngestFailures,
  getAllPageLinks,
  getAllPagePlans,
  getAllPages,
  getAllProvenance,
  getAllRelationshipMentions,
  getAllSources,
  getDb,
  getExportableSettings,
  getPendingFlushPages,
  getSchemaVersion,
  pagesFilePath,
  rawFilePath,
  DATA_ROOT,
} from './db';
import { getPageDraftRulesMap } from './draft-rules';
import { getPageHoldColumns } from './page-hold';
import { isBackedUpSetting } from './backup-settings';
import { getAllDisagreements } from './disagreement-backfill';
import { getAllClaimVerdicts } from './claim-check/verdicts';

/** Raw and page files are gzipped already: stored as they are, not compressed again. */
const GZIPPED = { compression: 'STORE' } as const;

/** A page's previous version as nlp-service file_store.py names it: {page_id}.{YYYYMMDD-HHMMSS}[-usec].md.gz */
const ARCHIVE_NAME = /^([a-z0-9][a-z0-9_-]*)\.\d{8}-\d{6}(?:-\d{6})?\.md\.gz$/;

/** The previous versions on disk, by page_id. */
async function pageArchives(): Promise<Map<string, string[]>> {
  const byPage = new Map<string, string[]>();
  let names: string[];
  try {
    names = await fs.readdir(path.join(DATA_ROOT, 'pages'));
  } catch {
    return byPage;
  }
  for (const name of names.sort()) {
    const match = ARCHIVE_NAME.exec(name);
    if (match) byPage.set(match[1], [...(byPage.get(match[1]) ?? []), name]);
  }
  return byPage;
}

export async function buildKomplBackup(opts: { includeVectors: boolean }): Promise<Buffer> {
  const zip = new JSZip();

  // Fetch vectors from nlp-service if requested, before reading any table:
  // the fetch can take a minute, and every table is read after it in one
  // snapshot, so a page committed meanwhile is in the backup with all its
  // rows or not at all (a page missing from pages.json loses its provenance
  // and links on restore). Such a page may lack its vector; the backfill
  // embeds it.
  let vectorCount = 0;
  if (opts.includeVectors) {
    try {
      const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';
      const vRes = await fetch(`${NLP_SERVICE_URL}/vectors/export`, {
        signal: AbortSignal.timeout(60_000),
      });
      if (vRes.ok) {
        const vData = await vRes.json() as { count: number; items: unknown[] };
        vectorCount = vData.count;
        zip.file('vectors.json', JSON.stringify(vData, null, 2));
      } else {
        console.warn(`[export] vectors/export returned ${vRes.status}, skipping vectors`);
      }
    } catch (e) {
      console.warn('[export] could not fetch vectors:', e instanceof Error ? e.message : e);
    }
  }

  // Every table in one read transaction: one consistent snapshot.
  const db = getDb();
  const snapshot = db.transaction(() => ({
    sources: getAllSources(),
    // Every page, those hidden from the wiki because all their sources are
    // archived included: provenance, links and aliases point at them, and a
    // backup without them could not be restored at all.
    pages: getAllPages(true),
    schemaVersion: getSchemaVersion(),
    draftRules: getPageDraftRulesMap(),
    holds: getPageHoldColumns(),
    provenance: getAllProvenance(),
    aliases: getAllAliases(),
    disagreements: getAllDisagreements(db),
    claimVerdicts: getAllClaimVerdicts(db),
    extractions: getAllExtractions(),
    pageLinks: getAllPageLinks(),
    entityMentions: getAllEntityMentions(),
    relationshipMentions: getAllRelationshipMentions(),
    drafts: getAllDrafts(),
    activityLog: getAllActivityLog(),
    compileProgress: getAllCompileProgress(),
    chatMessages: getAllChatMessages(),
    pagePlans: getAllPagePlans(),
    ingestFailures: getAllIngestFailures(),
    settings: getExportableSettings(),
    pendingFlush: getPendingFlushPages(),
  }))();
  const { sources, pages } = snapshot;

  const manifest = {
    format: 'kompl',
    version: 1,
    exported_at: new Date().toISOString(),
    schema_version: snapshot.schemaVersion,
    source_count: sources.length,
    page_count: pages.length,
    vector_count: vectorCount,
    app_version: '2.0.0',
  };
  // Raw or page files the database lists but the disk lacks.
  const missing: string[] = [];

  const dbFolder = zip.folder('db')!;
  dbFolder.file('sources.json', JSON.stringify(sources, null, 2));
  // draft_rules (v27) says which writing rules each page follows, so a
  // restored wiki offers the same pages for an update. Older releases'
  // imports ignore the extra field.
  // restore_page_type / archive_reason (v30) keep a page archived after a
  // failed rewrite restorable (lib/page-hold.ts).
  const { draftRules, holds } = snapshot;
  dbFolder.file(
    'pages.json',
    JSON.stringify(
      pages.map((p) => ({
        ...p,
        draft_rules: draftRules.get(p.page_id) ?? null,
        restore_page_type: holds.get(p.page_id)?.restore_page_type ?? null,
        archive_reason: holds.get(p.page_id)?.archive_reason ?? null,
      })),
      null,
      2,
    ),
  );
  dbFolder.file('provenance.json', JSON.stringify(snapshot.provenance, null, 2));
  // Every alias row, set aside or not, with how it was made and its status
  // (v29), so a restore keeps them. Older releases' imports ignore them.
  dbFolder.file('aliases.json', JSON.stringify(snapshot.aliases, null, 2));
  // The disagreements record (v30) with the owner's verdicts, so a restore
  // keeps them. Older releases' imports ignore the file.
  dbFolder.file('disagreements.json', JSON.stringify(snapshot.disagreements, null, 2));
  // The claim check's saved verdicts (v30), so a restored wiki never pays
  // to judge the same claim pair again. Older releases' imports ignore it.
  dbFolder.file('claim_verdicts.json', JSON.stringify(snapshot.claimVerdicts, null, 2));
  dbFolder.file('extractions.json', JSON.stringify(snapshot.extractions, null, 2));
  dbFolder.file('page_links.json', JSON.stringify(snapshot.pageLinks, null, 2));
  dbFolder.file('entity_mentions.json', JSON.stringify(snapshot.entityMentions, null, 2));
  dbFolder.file('relationship_mentions.json', JSON.stringify(snapshot.relationshipMentions, null, 2));
  dbFolder.file('drafts.json', JSON.stringify(snapshot.drafts, null, 2));
  dbFolder.file('activity_log.json', JSON.stringify(snapshot.activityLog, null, 2));
  dbFolder.file('compile_progress.json', JSON.stringify(snapshot.compileProgress, null, 2));
  dbFolder.file('chat_messages.json', JSON.stringify(snapshot.chatMessages, null, 2));
  dbFolder.file('page_plans.json', JSON.stringify(snapshot.pagePlans, null, 2));
  // The links the owner saved that could not be fetched, which the Saved
  // Links page lists. Older releases' imports ignore the file.
  dbFolder.file('ingest_failures.json', JSON.stringify(snapshot.ingestFailures, null, 2));
  // The schema version travels in manifest.json. Older Kompl releases copy
  // every settings row on import, so a schema_version row here would
  // overwrite an older install's own version and leave it "degraded".
  // Install-only rows are left out (lib/backup-settings.ts).
  dbFolder.file(
    'settings.json',
    JSON.stringify(
      snapshot.settings.filter((s) => isBackedUpSetting(s.key)),
      null,
      2,
    ),
  );

  const rawFolder = zip.folder('raw')!;
  for (const s of sources) {
    try {
      rawFolder.file(`${s.source_id}.md.gz`, await fs.readFile(rawFilePath(s.source_id)), GZIPPED);
    } catch {
      missing.push(`raw/${s.source_id}.md.gz`);
    }
  }

  // A page committed but not yet written to disk (pages.pending_content,
  // CLAUDE.md rule 5) goes in with that newest text: its file is older or
  // missing.
  const pendingText = new Map(snapshot.pendingFlush.map((p) => [p.page_id, p.pending_content]));
  const archives = await pageArchives();
  const pagesFolder = zip.folder('pages')!;
  for (const p of pages) {
    const pending = pendingText.get(p.page_id);
    if (pending !== undefined) {
      pagesFolder.file(`${p.page_id}.md.gz`, zlib.gzipSync(Buffer.from(pending, 'utf-8')), GZIPPED);
    } else {
      try {
        pagesFolder.file(`${p.page_id}.md.gz`, await fs.readFile(pagesFilePath(p.page_id)), GZIPPED);
      } catch {
        missing.push(`pages/${p.page_id}.md.gz`);
      }
    }
    // Its previous versions, so "View previous version" and "Restore this
    // version" still work on the restored wiki. Every release's import
    // writes each pages/ file back under its own name.
    for (const name of archives.get(p.page_id) ?? []) {
      try {
        pagesFolder.file(name, await fs.readFile(path.join(DATA_ROOT, 'pages', name)), GZIPPED);
      } catch { /* trimmed meanwhile */ }
    }
  }

  try {
    zip.file('schema.md', await fs.readFile(path.join(DATA_ROOT, 'schema.md'), 'utf-8'));
  } catch { /* no schema.md yet */ }

  // Written last, naming any file that could not go in, so a backup is never
  // short without saying so. Older releases' imports ignore the extra field.
  if (missing.length > 0) {
    console.warn(`[export] ${missing.length} file(s) not on disk, not in the backup: ${missing.slice(0, 20).join(', ')}`);
  }
  zip.file('manifest.json', JSON.stringify({ ...manifest, missing_files: missing }, null, 2));

  // Deflated: the tables' JSON shrinks several times over, which keeps the
  // backup, and the memory taking and restoring it needs, small. Every
  // release's import reads deflated entries.
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}
