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
 *   { session_id: string; stage_ids: string[] }
 *
 * No per-item failure path — staging is a local DB insert that shouldn't
 * fail under normal conditions. Whole-batch failure returns 500 with the
 * best available error message.
 */

import { randomUUID } from 'node:crypto';
import { NextResponse } from 'next/server';

import { insertCollectStaging, type StagingConnector } from '../../../../lib/db';

const VALID_CONNECTORS: readonly StagingConnector[] = [
  'url',
  'file-upload',
  'text',
  'saved-link',
] as const;

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

  // Per-connector payload presence check. Full payload validation (shape,
  // types) lives inside the ingest step modules — this route does minimum
  // gating so obviously-broken client calls fail fast rather than at
  // pipeline dispatch time.
  const stage_ids: string[] = [];
  try {
    for (const raw of items) {
      if (typeof raw !== 'object' || raw === null) {
        return NextResponse.json(
          { error: 'each item must be an object' },
          { status: 422 }
        );
      }
      const item = raw as Record<string, unknown>;

      // Connector-specific required-field checks.
      if (connector === 'url' || connector === 'saved-link') {
        if (typeof item.url !== 'string' || !item.url) {
          return NextResponse.json(
            { error: `connector='${connector}' requires item.url` },
            { status: 422 }
          );
        }
      } else if (connector === 'file-upload') {
        if (typeof item.file_path !== 'string' || !item.file_path) {
          return NextResponse.json(
            { error: "connector='file-upload' requires item.file_path" },
            { status: 422 }
          );
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

      const stage_id = randomUUID();
      insertCollectStaging({
        stage_id,
        session_id,
        connector,
        payload: item,
      });
      stage_ids.push(stage_id);
    }
  } catch (e) {
    const msg = e instanceof Error ? e.message : 'unknown';
    return NextResponse.json(
      { error: `stage_insert_failed: ${msg}` },
      { status: 500 }
    );
  }

  return NextResponse.json({ session_id, stage_ids }, { status: 200 });
}
