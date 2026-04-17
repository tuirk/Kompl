export const dynamic = 'force-dynamic';

import JSZip from 'jszip';
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { NextResponse } from 'next/server';

import { getDb, DATA_ROOT, insertActivity } from '@/lib/db';

// System-generated pages that don't count as "user data" for the import
// emptiness check. The Saved Links overview page is rebuilt any time an
// ingest fails; it must not block a fresh import into an otherwise-empty wiki.
const SYSTEM_PAGE_IDS = ['saved-links'] as const;

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
  let manifest: { format: string; version: number };
  try {
    manifest = JSON.parse(manifestRaw) as { format: string; version: number };
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
  const systemPlaceholders = SYSTEM_PAGE_IDS.map(() => '?').join(', ');
  const userPageCount = (
    db
      .prepare(`SELECT COUNT(*) AS n FROM pages WHERE page_id NOT IN (${systemPlaceholders})`)
      .get(...SYSTEM_PAGE_IDS) as { n: number }
  ).n;
  if (userPageCount > 0) {
    return NextResponse.json(
      {
        error: 'wiki_not_empty',
        message: 'Import is only supported on an empty wiki. Delete all existing data first.',
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
  const settings    = JSON.parse((await zip.file('db/settings.json')?.async('string')) ?? '[]') as Record<string, string>[];
  const schemaContent = (await zip.file('schema.md')?.async('string')) ?? null;

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

  db.transaction(() => {
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
      db.prepare(
        `INSERT OR IGNORE INTO sources
           (source_id, title, source_type, source_url, content_hash, file_path,
            status, date_ingested, metadata, compile_status, onboarding_session_id)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', NULL)`
      ).run(
        s.source_id as string,
        s.title as string,
        s.source_type as string,
        (s.source_url as string | null) ?? null,
        s.content_hash as string,
        s.file_path as string,
        (s.status as string | null) ?? 'active',
        s.date_ingested as string,
        (s.metadata as string | null) ?? null
      );
    }

    for (const p of pages) {
      db.prepare(
        `INSERT OR IGNORE INTO pages
           (page_id, title, page_type, category, summary, content_path,
            previous_content_path, last_updated, source_count, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(
        p.page_id as string,
        p.title as string,
        p.page_type as string,
        (p.category as string | null) ?? null,
        (p.summary as string | null) ?? null,
        p.content_path as string,
        (p.previous_content_path as string | null) ?? null,
        p.last_updated as string,
        (p.source_count as number | null) ?? 0,
        p.created_at as string
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

    for (const pr of provenance) {
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

    for (const a of aliases) {
      db.prepare(
        `INSERT OR IGNORE INTO aliases (alias, canonical_name, canonical_page_id) VALUES (?, ?, ?)`
      ).run(
        a.alias as string,
        a.canonical_name as string,
        (a.canonical_page_id as string | null) ?? null
      );
    }

    for (const e of extractions) {
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

    for (const s of settings) {
      db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)`).run(s.key, s.value);
    }

    db.prepare(`INSERT OR REPLACE INTO settings (key, value) VALUES ('onboarding_completed', '1')`).run();
  })();

  // -------------------------------------------------------------------------
  // Phase 3: Vector restore or backfill + activity log
  // -------------------------------------------------------------------------

  // If the zip contains pre-computed embeddings, restore them directly
  // (no re-embedding needed). Otherwise fall back to the backfill endpoint.
  const vectorsJson = await zip.file('vectors.json')?.async('string');
  const NLP_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';
  if (vectorsJson) {
    try {
      const vData = JSON.parse(vectorsJson) as { items: unknown[] };
      if (Array.isArray(vData.items) && vData.items.length > 0) {
        void fetch(`${NLP_URL}/vectors/restore`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ items: vData.items }),
          signal: AbortSignal.timeout(120_000),
        }).catch((e: unknown) => {
          console.error('[import] vectors/restore failed, falling back to backfill:', e instanceof Error ? e.message : e);
          void fetch(`${process.env.APP_URL ?? 'http://app:3000'}/api/compile/backfill-vectors`, {
            method: 'POST',
            signal: AbortSignal.timeout(300_000),
          }).catch(() => {});
        });
      }
    } catch {
      // JSON parse error — fall through to backfill
      void fetch(`${process.env.APP_URL ?? 'http://app:3000'}/api/compile/backfill-vectors`, {
        method: 'POST',
        signal: AbortSignal.timeout(300_000),
      }).catch(() => {});
    }
  } else {
    // No vectors in zip — trigger standard re-embed backfill
    void fetch(`${process.env.APP_URL ?? 'http://app:3000'}/api/compile/backfill-vectors`, {
      method: 'POST',
      signal: AbortSignal.timeout(300_000),
    }).catch(() => {});
  }

  insertActivity({
    action_type: 'wiki_imported',
    source_id: null,
    details: {
      source_count: sources.length,
      page_count: pages.length,
      format_version: manifest.version,
    },
  });

  return NextResponse.json({ imported: true, sources: sources.length, pages: pages.length });
}
