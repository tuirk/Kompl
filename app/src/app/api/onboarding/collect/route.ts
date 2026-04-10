/**
 * POST /api/onboarding/collect
 *
 * Called by the onboarding UI to convert and store sources WITHOUT triggering
 * compilation. Sources are stored with compile_status='collected' so the
 * compile drain ignores them until the user clicks "Build your wiki."
 *
 * Request:
 *   {
 *     session_id: string;         // client-generated UUID for this onboarding run
 *     connector: 'url' | 'file-upload';
 *     items: Array<{
 *       url?: string;             // for connector='url'
 *       file_path?: string;       // for connector='file-upload' (file already on disk)
 *       title_hint?: string;
 *     }>;
 *   }
 *
 * Response:
 *   {
 *     session_id: string;
 *     stored: SourceRow[];
 *     failed: Array<{ item: object; error: string }>;
 *     warnings: Array<{ source_id: string; warning: string }>;
 *   }
 *
 * Notes:
 * - Calls nlp-service /convert/* directly (same pattern as compile/commit).
 *   No n8n involved — collect is a simple convert-and-store operation.
 * - Calls are sequential per item. For Part 1a (curl testing) this is fine.
 *   Part 1b must decide: loading indicator vs. async job + poll.
 * - YouTube URLs are detected and flagged with warning='youtube_no_transcript'.
 *   They still go through Firecrawl (best-effort) since yt-dlp is not wired yet.
 */

import { randomUUID } from 'crypto';
import { NextResponse } from 'next/server';

import {
  getDb,
  insertSource,
  storeRawMarkdown,
} from '../../../../lib/db';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isYouTubeUrl(url: string): boolean {
  return /^https?:\/\/(www\.)?(youtube\.com\/watch|youtu\.be\/)/.test(url);
}

interface ConvertResponse {
  source_id: string;
  source_type: string;
  title: string;
  source_url: string | null;
  markdown: string;
  content_hash: string;
  metadata: Record<string, unknown>;
}

async function callConvertUrl(sourceId: string, url: string): Promise<ConvertResponse> {
  const res = await fetch(`${NLP_SERVICE_URL}/convert/url`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id: sourceId, url }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`convert_url_failed: ${res.status} ${detail}`);
  }
  return res.json() as Promise<ConvertResponse>;
}

async function callConvertFilePath(
  sourceId: string,
  filePath: string,
  titleHint?: string
): Promise<ConvertResponse> {
  const res = await fetch(`${NLP_SERVICE_URL}/convert/file-path`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id: sourceId, file_path: filePath, title_hint: titleHint }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`convert_file_failed: ${res.status} ${detail}`);
  }
  return res.json() as Promise<ConvertResponse>;
}

// ---------------------------------------------------------------------------
// Route handler
// ---------------------------------------------------------------------------

interface CollectItem {
  url?: string;
  file_path?: string;
  title_hint?: string;
}

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (typeof rawBody !== 'object' || rawBody === null) {
    return NextResponse.json({ error: 'body must be an object' }, { status: 422 });
  }

  const body = rawBody as Record<string, unknown>;

  if (typeof body.session_id !== 'string' || !body.session_id) {
    return NextResponse.json({ error: 'missing field: session_id' }, { status: 422 });
  }
  if (body.connector !== 'url' && body.connector !== 'file-upload') {
    return NextResponse.json(
      { error: 'connector must be "url" or "file-upload"' },
      { status: 422 }
    );
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: 'items must be a non-empty array' }, { status: 422 });
  }

  const { session_id, connector } = body as { session_id: string; connector: 'url' | 'file-upload' };
  const items = body.items as CollectItem[];

  const stored: object[] = [];
  const failed: Array<{ item: CollectItem; error: string }> = [];
  const warnings: Array<{ source_id: string; warning: string }> = [];

  const db = getDb();

  for (const item of items) {
    // Validate per-item shape
    if (connector === 'url' && (typeof item.url !== 'string' || !item.url)) {
      failed.push({ item, error: 'missing url for connector=url' });
      continue;
    }
    if (connector === 'file-upload' && (typeof item.file_path !== 'string' || !item.file_path)) {
      failed.push({ item, error: 'missing file_path for connector=file-upload' });
      continue;
    }

    const sourceId = randomUUID();

    // YouTube detection — flag but proceed with Firecrawl (no yt-dlp yet)
    if (connector === 'url' && isYouTubeUrl(item.url!)) {
      warnings.push({ source_id: sourceId, warning: 'youtube_no_transcript' });
    }

    try {
      // Call nlp-service for conversion
      let convertResult: ConvertResponse;
      if (connector === 'url') {
        convertResult = await callConvertUrl(sourceId, item.url!);
      } else {
        convertResult = await callConvertFilePath(sourceId, item.file_path!, item.title_hint);
      }

      // Check for duplicate content (same hash already in DB as a non-collected source)
      const existingDupe = db
        .prepare(
          `SELECT source_id FROM sources
            WHERE content_hash = ? AND compile_status != 'collected'
            LIMIT 1`
        )
        .get(convertResult.content_hash) as { source_id: string } | null;
      if (existingDupe) {
        warnings.push({ source_id: sourceId, warning: `duplicate_of:${existingDupe.source_id}` });
      }

      // Store raw markdown + insert source row
      const filePath = storeRawMarkdown(sourceId, convertResult.markdown);

      // insertSource is sync — safe outside transaction since we're not
      // doing multi-step DB writes here (single insert, idempotent on failure).
      insertSource({
        source_id: sourceId,
        title: convertResult.title,
        source_type: convertResult.source_type,
        source_url: convertResult.source_url,
        content_hash: convertResult.content_hash,
        file_path: filePath,
        metadata: convertResult.metadata,
        compile_status: 'collected',
        onboarding_session_id: session_id,
      });

      stored.push({
        source_id: sourceId,
        title: convertResult.title,
        source_type: convertResult.source_type,
        source_url: convertResult.source_url,
        content_hash: convertResult.content_hash,
        onboarding_session_id: session_id,
      });
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown';
      failed.push({ item, error: msg });
    }
  }

  return NextResponse.json({ session_id, stored, failed, warnings }, { status: 200 });
}
