/**
 * POST /api/sources/store
 *
 * Called BY n8n (internal server-to-server), NOT by the browser. This is
 * the first real instance of the Pass-5 three-phase commit pattern.
 *
 * Rule #5 (better-sqlite3 sync-only transactions) applies here:
 *   Phase 1 — async pre-work  (parse/validate request body)
 *   Phase 2 — sync db.transaction(() => { INSERT source + activity +
 *             write gzipped markdown to filesystem })
 *   Phase 3 — fire-and-forget (none in commit 3; vector upsert lands in
 *             commit 6)
 *
 * Inside the Phase 2 callback there must be ZERO `await` calls. File
 * writes use the synchronous fs.writeFileSync path in storeRawMarkdown
 * so the DB insert and the file write commit together.
 *
 * Request shape (from docs/contracts.md contract 3):
 *   {
 *     source_id, source_type, title, source_url, markdown,
 *     content_hash, metadata: {language, description, status_code,
 *                              content_type, final_url}
 *   }
 *
 * Response (success, 200):
 *   {source_id, status: "stored", file_path: "/data/raw/<id>.md.gz"}
 *
 * Errors:
 *   422 — body doesn't match shape
 *   409 — source_id already exists (idempotent retry)
 *   500 — unexpected DB/FS error
 */

import { NextResponse } from 'next/server';

import {
  getDb,
  insertActivity,
  insertSource,
  rawFilePath,
  sourceExists,
  storeRawMarkdown,
} from '../../../../lib/db';

interface StoreRequestMetadata {
  language: string | null;
  description: string | null;
  status_code: number | null;
  content_type: string | null;
  final_url: string | null;
}

interface StoreRequest {
  source_id: string;
  source_type: string;
  title: string;
  source_url: string | null;
  markdown: string;
  content_hash: string;
  metadata: StoreRequestMetadata;
}

function validate(body: unknown): StoreRequest | { error: string } {
  if (typeof body !== 'object' || body === null) return { error: 'body must be an object' };
  const b = body as Record<string, unknown>;

  const required = ['source_id', 'source_type', 'title', 'markdown', 'content_hash', 'metadata'];
  for (const key of required) {
    if (!(key in b)) return { error: `missing field: ${key}` };
  }

  if (typeof b.source_id !== 'string' || !b.source_id) return { error: 'source_id must be non-empty string' };
  if (typeof b.source_type !== 'string') return { error: 'source_type must be string' };
  if (b.source_type !== 'url' && b.source_type !== 'file') {
    return { error: 'source_type must be "url" or "file"' };
  }
  if (typeof b.title !== 'string') return { error: 'title must be string' };
  if (typeof b.markdown !== 'string' || !b.markdown) return { error: 'markdown must be non-empty string' };
  if (typeof b.content_hash !== 'string') return { error: 'content_hash must be string' };
  if (b.source_url !== null && b.source_url !== undefined && typeof b.source_url !== 'string') {
    return { error: 'source_url must be string or null' };
  }

  const m = b.metadata;
  if (typeof m !== 'object' || m === null) return { error: 'metadata must be object' };
  const md = m as Record<string, unknown>;

  function checkNullableString(key: string): boolean {
    return md[key] === null || md[key] === undefined || typeof md[key] === 'string';
  }
  function checkNullableNumber(key: string): boolean {
    return md[key] === null || md[key] === undefined || typeof md[key] === 'number';
  }

  if (!checkNullableString('language')) return { error: 'metadata.language must be string or null' };
  if (!checkNullableString('description')) return { error: 'metadata.description must be string or null' };
  if (!checkNullableNumber('status_code')) return { error: 'metadata.status_code must be number or null' };
  if (!checkNullableString('content_type')) return { error: 'metadata.content_type must be string or null' };
  if (!checkNullableString('final_url')) return { error: 'metadata.final_url must be string or null' };

  return {
    source_id: b.source_id,
    source_type: b.source_type,
    title: b.title,
    source_url: (b.source_url as string | null | undefined) ?? null,
    markdown: b.markdown,
    content_hash: b.content_hash,
    metadata: {
      language: (md.language as string | null | undefined) ?? null,
      description: (md.description as string | null | undefined) ?? null,
      status_code: (md.status_code as number | null | undefined) ?? null,
      content_type: (md.content_type as string | null | undefined) ?? null,
      final_url: (md.final_url as string | null | undefined) ?? null,
    },
  };
}

export async function POST(request: Request) {
  // ---- Phase 1: async pre-work (parse + validate) ----
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const validated = validate(rawBody);
  if ('error' in validated) {
    return NextResponse.json({ error: validated.error }, { status: 422 });
  }

  // Idempotency check — if n8n retried after a prior successful store,
  // return 409 so n8n's error handler treats it as "already done".
  if (sourceExists(validated.source_id)) {
    return NextResponse.json({ error: 'duplicate_source_id' }, { status: 409 });
  }

  // ---- Phase 2: synchronous db.transaction callback ----
  // File write + DB INSERTs commit together. If any throw, the whole
  // transaction rolls back. NO `await` inside this callback.
  const db = getDb();
  let file_path: string;
  try {
    const txn = db.transaction(() => {
      file_path = storeRawMarkdown(validated.source_id, validated.markdown);
      insertSource({
        source_id: validated.source_id,
        title: validated.title,
        source_type: validated.source_type,
        source_url: validated.source_url,
        content_hash: validated.content_hash,
        file_path,
        metadata: {
          language: validated.metadata.language,
          description: validated.metadata.description,
          status_code: validated.metadata.status_code,
          content_type: validated.metadata.content_type,
          final_url: validated.metadata.final_url,
        },
      });
      insertActivity({
        action_type: 'source_stored',
        source_id: validated.source_id,
        details: {
          title: validated.title,
          file_path,
          source_type: validated.source_type,
        },
      });
    });
    txn();
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown';
    // UNIQUE constraint violation on source_id → 409 (race with idempotency check).
    if (/UNIQUE constraint/i.test(message)) {
      return NextResponse.json({ error: 'duplicate_source_id' }, { status: 409 });
    }
    return NextResponse.json({ error: `store_failed: ${message}` }, { status: 500 });
  }

  // ---- Phase 3: fire-and-forget ----
  // Trigger compile via n8n webhook. Non-blocking — if n8n is unreachable,
  // log the failure and continue. The compile-drain poller (every 10s) will
  // pick up sources that slipped through here. Belt-and-suspenders.
  const n8nUrl = process.env.N8N_URL ?? 'http://n8n:5678';
  fetch(`${n8nUrl}/webhook/compile`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id: validated.source_id }),
    signal: AbortSignal.timeout(5_000),
  }).catch((err: unknown) => {
    // Log to activity so the user can see the trigger failed, but don't
    // surface this to the caller — the poller recovers it.
    const message = err instanceof Error ? err.message : 'unknown';
    try {
      insertActivity({
        action_type: 'compile_trigger_failed',
        source_id: validated.source_id,
        details: { error: message },
      });
    } catch {
      // Swallow — if we can't write to activity either, we can't do much.
    }
  });

  return NextResponse.json(
    {
      source_id: validated.source_id,
      status: 'stored',
      file_path: rawFilePath(validated.source_id),
    },
    { status: 200 }
  );
}
