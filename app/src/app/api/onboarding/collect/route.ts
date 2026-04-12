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
 *     connector: 'url' | 'file-upload' | 'text';
 *     items: Array<{
 *       url?: string;             // for connector='url'
 *       file_path?: string;       // for connector='file-upload' (file already on disk)
 *       markdown?: string;        // for connector='text' (content already known client-side)
 *       title_hint?: string;
 *       source_type_hint?: string; // e.g. 'note', 'tweet' — used as source_type for connector='text'
 *       metadata?: Record<string, unknown>;      // for connector='text': stored directly
 *       metadata_hint?: Record<string, unknown>; // for 'url'/'file-upload': merged into NLP metadata
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

import { createHash, randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import {
  getDb,
  insertIngestFailure,
  insertSource,
  storeRawMarkdown,
} from '../../../../lib/db';
import { regenerateSavedLinksPage } from '../../../../lib/saved-links';

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
  markdown?: string;
  title_hint?: string;
  source_type_hint?: string;
  metadata?: Record<string, unknown>;
  metadata_hint?: Record<string, unknown>;
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
  const VALID_CONNECTORS = ['url', 'file-upload', 'text'] as const;
  type Connector = (typeof VALID_CONNECTORS)[number];
  if (!VALID_CONNECTORS.includes(body.connector as Connector)) {
    return NextResponse.json({ error: 'unknown connector' }, { status: 422 });
  }
  if (!Array.isArray(body.items) || body.items.length === 0) {
    return NextResponse.json({ error: 'items must be a non-empty array' }, { status: 422 });
  }

  const { session_id, connector } = body as { session_id: string; connector: 'url' | 'file-upload' | 'text' };
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
    if (connector === 'text' && (typeof item.markdown !== 'string' || !item.markdown.trim())) {
      failed.push({ item, error: 'missing markdown for connector=text' });
      continue;
    }

    const sourceId = randomUUID();

    // ── connector: 'text' — content already known, skip nlp-service ──────────
    if (connector === 'text') {
      try {
        const md = item.markdown!.trim();
        const hash = createHash('sha256').update(md).digest('hex');
        const title = item.title_hint?.trim() || 'Untitled';
        const sourceType = item.source_type_hint ?? 'text';
        const filePath = storeRawMarkdown(sourceId, md);

        const existingDupe = db
          .prepare(
            `SELECT source_id FROM sources
              WHERE content_hash = ? AND compile_status != 'collected'
              LIMIT 1`
          )
          .get(hash) as { source_id: string } | null;
        if (existingDupe) {
          warnings.push({ source_id: sourceId, warning: `duplicate_of:${existingDupe.source_id}` });
        }

        insertSource({
          source_id: sourceId,
          title,
          source_type: sourceType,
          source_url: null,
          content_hash: hash,
          file_path: filePath,
          metadata: item.metadata ?? null,
          compile_status: 'collected',
          onboarding_session_id: session_id,
        });

        stored.push({
          source_id: sourceId,
          title,
          source_type: sourceType,
          source_url: null,
          content_hash: hash,
          onboarding_session_id: session_id,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : 'unknown';
        failed.push({ item, error: msg });
        // For tweet text failures, preserve tweet_url + title_hint so the link
        // is not lost even when the DB insert itself fails.
        const tweetUrl = typeof item.metadata?.tweet_url === 'string' ? item.metadata.tweet_url : null;
        if (tweetUrl) {
          const dateSaved = typeof item.metadata?.date_saved === 'string' ? item.metadata.date_saved : null;
          insertIngestFailure({
            failure_id: randomUUID(),
            source_url: tweetUrl,
            title_hint: item.title_hint ?? null,
            date_saved: dateSaved,
            error: msg,
            source_type: 'tweet',
          });
          void regenerateSavedLinksPage().catch(() => {});
        }
      }
      continue;
    }

    // ── connector: 'url' / 'file-upload' — call nlp-service ─────────────────

    // YouTube detection — MarkItDown will attempt transcript extraction via
    // youtube-transcript-api. If no transcript is available it falls back to
    // Firecrawl. Warning is surfaced in the UI only when fallback was used.
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

      // Merge metadata_hint (e.g. date_saved from browser bookmarks) into NLP metadata
      const finalMetadata: Record<string, unknown> = item.metadata_hint
        ? { ...(convertResult.metadata ?? {}), ...item.metadata_hint }
        : convertResult.metadata;

      // Check for duplicate: URL match first (same URL = same source even if content drifted),
      // then fall back to content hash (for file uploads, tweets, non-URL sources).
      const urlDupe = convertResult.source_url
        ? (db
            .prepare(
              `SELECT source_id FROM sources
                WHERE source_url = ? AND compile_status != 'collected'
                LIMIT 1`
            )
            .get(convertResult.source_url) as { source_id: string } | null)
        : null;
      const hashDupe = urlDupe
        ? null
        : (db
            .prepare(
              `SELECT source_id FROM sources
                WHERE content_hash = ? AND compile_status != 'collected'
                LIMIT 1`
            )
            .get(convertResult.content_hash) as { source_id: string } | null);
      const existingDupe = urlDupe ?? hashDupe;
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
        metadata: finalMetadata,
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
      // Persist the link so it appears on the Saved Links wiki page even if
      // scraping failed. URL bookmarks have url + optional title_hint +
      // optional date_saved from browser export.
      if (connector === 'url' && item.url) {
        const dateSaved =
          typeof item.metadata_hint?.date_saved === 'string' ? item.metadata_hint.date_saved : null;
        insertIngestFailure({
          failure_id: randomUUID(),
          source_url: item.url,
          title_hint: item.title_hint ?? null,
          date_saved: dateSaved,
          error: msg,
          source_type: 'url',
        });
        void regenerateSavedLinksPage().catch(() => {});
      }
    }
  }

  return NextResponse.json({ session_id, stored, failed, warnings }, { status: 200 });
}
