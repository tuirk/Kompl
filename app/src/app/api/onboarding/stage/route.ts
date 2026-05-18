/**
 * POST /api/onboarding/stage
 *
 * Writes pre-ingestion intent into collect_staging. Called by the onboarding
 * connector UIs (v2: URL paste, bookmarks, file upload, Twitter, Upnote)
 * instead of the legacy synchronous /collect route. No Firecrawl, no
 * MarkItDown, no sources insert — just one row per item in collect_staging.
 *
 * The review page (GET /api/onboarding/staging) then reads these rows;
 * POST /api/onboarding/finalize promotes them to sources via the pipeline's
 * new prelude steps (health-check → ingest_files → ingest_urls → ingest_texts).
 *
 * Request:
 *   {
 *     session_id: string;
 *     connector: 'url' | 'file-upload' | 'text' | 'saved-link';
 *     items: Array<{ ...connector-specific payload fields... }>;
 *   }
 *
 * Response:
 *   {
 *     session_id: string;
 *     stage_ids: string[];
 *     blocked_count: number;
 *     blocked_urls?: string[];   // present when blocked_count > 0, capped at 10
 *   }
 *
 * Per-item failure path — blocked-host URLs (x.com, twitter.com, t.co) are
 * skipped and reported via blocked_count/blocked_urls without aborting the
 * batch. Other validation errors still 422 the whole batch (malformed-payload
 * signal). DB-level batch failure still returns 500 with the underlying error.
 */

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import {
  getDb,
  logActivity,
  insertCollectStaging,
  type StagingConnector,
} from '../../../../lib/db';
import { isBlockedHost } from '../../../../lib/url-blocklist';

const VALID_CONNECTORS: readonly StagingConnector[] = [
  'url',
  'file-upload',
  'text',
  'saved-link',
  'paste',
] as const;

const PASTE_TITLE_MAX = 200;

function isValidHttpUrl(value: string): boolean {
  try {
    const parsed = new URL(value);
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

function isValidConnector(v: unknown): v is StagingConnector {
  return typeof v === 'string' && (VALID_CONNECTORS as readonly string[]).includes(v);
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
  if (!isValidConnector(body.connector)) {
    return NextResponse.json(
      { error: `connector must be one of: ${VALID_CONNECTORS.join(', ')}` },
      { status: 422 }
    );
  }
  if (!Array.isArray(body.items)) {
    return NextResponse.json({ error: 'items must be an array' }, { status: 422 });
  }
  if (body.items.length === 0) {
    return NextResponse.json({ error: 'items array is empty' }, { status: 422 });
  }

  const session_id = body.session_id;
  const connector = body.connector as StagingConnector;
  const items = body.items as unknown[];

  // Phase 1 — validate everything before opening a transaction. Validation
  // failures return 422 without any partial inserts to roll back. Full
  // payload validation (shape, types) lives in the ingest step modules;
  // this route does minimum gating so obviously-broken client calls fail
  // fast rather than at pipeline dispatch time.
  const validatedItems: Array<{ stage_id: string; item: Record<string, unknown> }> = [];
  const blockedUrls: string[] = [];
  for (const raw of items) {
    if (typeof raw !== 'object' || raw === null) {
      return NextResponse.json(
        { error: 'each item must be an object' },
        { status: 422 }
      );
    }
    const item = raw as Record<string, unknown>;

    if (connector === 'url' || connector === 'saved-link') {
      if (typeof item.url !== 'string' || !item.url) {
        return NextResponse.json(
          { error: `connector='${connector}' requires item.url` },
          { status: 422 }
        );
      }
      // The URL connector is user-initiated ("paste a link"); saved-link is
      // internal plumbing that may legitimately carry an x.com tweet_url in
      // its metadata. Only block the user-initiated path.
      //
      // Per-item skip, not batch-abort: a Chrome bookmarks export with 300
      // links and 3 Twitter URLs should stage 297 and report 3 as blocked,
      // not reject the whole batch (regression from earlier 422 behaviour).
      if (connector === 'url' && isBlockedHost(item.url)) {
        blockedUrls.push(item.url);
        continue;
      }
    } else if (connector === 'file-upload') {
      if (typeof item.file_path !== 'string' || !item.file_path) {
        return NextResponse.json(
          { error: "connector='file-upload' requires item.file_path" },
          { status: 422 }
        );
      }
    } else if (connector === 'paste') {
      // Paste blocks: user-supplied title + body, optional source_url metadata.
      // Host blocklist is intentionally not applied — paste is user-curated;
      // the blocklist exists to stop scraping x.com pages that have no useful
      // HTML, irrelevant when the user already has the text in hand.
      if (typeof item.title !== 'string' || !item.title.trim()) {
        return NextResponse.json(
          { error: "connector='paste' requires item.title" },
          { status: 422 }
        );
      }
      if (item.title.length > PASTE_TITLE_MAX) {
        return NextResponse.json(
          { error: `connector='paste' item.title exceeds ${PASTE_TITLE_MAX} chars` },
          { status: 422 }
        );
      }
      if (typeof item.text !== 'string' || !item.text) {
        return NextResponse.json(
          { error: "connector='paste' requires item.text" },
          { status: 422 }
        );
      }
      if (item.source_url != null) {
        if (typeof item.source_url !== 'string' || !isValidHttpUrl(item.source_url)) {
          return NextResponse.json(
            { error: "connector='paste' item.source_url must be a valid http(s) URL" },
            { status: 422 }
          );
        }
      }
    } else {
      // connector === 'text'
      if (typeof item.markdown !== 'string' || !item.markdown) {
        return NextResponse.json(
          { error: "connector='text' requires item.markdown" },
          { status: 422 }
        );
      }
    }

    validatedItems.push({ stage_id: randomUUID(), item });
  }

  // Phase 2 — batch insert in one transaction. Matters for bulk imports
  // (200-bookmark exports go from ~100 individual transactions to 1).
  // Skipped when validatedItems is empty (all URLs filtered out) — no point
  // opening a tx to do nothing.
  if (validatedItems.length > 0) {
    try {
      getDb().transaction(() => {
        for (const { stage_id, item } of validatedItems) {
          insertCollectStaging({ stage_id, session_id, connector, payload: item });
        }
      })();
    } catch (e) {
      const msg = e instanceof Error ? e.message : 'unknown';
      return NextResponse.json(
        { error: `stage_insert_failed: ${msg}` },
        { status: 500 }
      );
    }
  }

  // Observability: emitted once per batch so the feed shows a timeline of
  // "user staged X at 14:02". Suppressed when count would be 0 (nothing
  // staged) to keep the feed quiet.
  if (validatedItems.length > 0) {
    logActivity('onboarding_staged', {
      source_id: null,
      details: { session_id, connector, count: validatedItems.length },
    });
  }
  if (blockedUrls.length > 0) {
    logActivity('onboarding_blocked_urls_skipped', {
      source_id: null,
      details: {
        session_id,
        connector,
        count: blockedUrls.length,
        sample_urls: blockedUrls.slice(0, 3),
      },
    });
  }

  const stage_ids = validatedItems.map((v) => v.stage_id);
  const response: {
    session_id: string;
    stage_ids: string[];
    blocked_count: number;
    blocked_urls?: string[];
  } = {
    session_id,
    stage_ids,
    blocked_count: blockedUrls.length,
  };
  if (blockedUrls.length > 0) {
    response.blocked_urls = blockedUrls.slice(0, 10);
  }
  return NextResponse.json(response, { status: 200 });
}
