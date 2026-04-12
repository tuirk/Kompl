/**
 * POST /api/ingest/url
 *
 * Browser → this route (same-origin Next.js) → this route POSTs to n8n's
 * internal webhook (Sidecar pattern, see CLAUDE.md rule #3 and
 * docs/research/2026-04-08-commit-3-architecture.md).
 *
 * Request:  {urls: string[]}
 * Response: {accepted: number, source_ids: string[]}
 *
 * For each URL:
 *   1. Generate a UUID source_id.
 *   2. Write an "ingest_accepted" row to activity_log.
 *   3. POST {source_id, source_type:"url", source_ref:url} to
 *      http://n8n:5678/webhook/ingest (5s timeout).
 *   4. If the n8n call fails, mark the source as failed in activity_log
 *      and continue with the next URL — partial success is fine; the
 *      feed UI will show per-source status.
 *
 * n8n webhook is configured with responseMode: onReceived so it returns
 * 202 immediately; we don't wait for workflow completion.
 */

import { NextResponse } from 'next/server';
import { randomUUID } from 'node:crypto';

import { getDb, insertActivity, insertIngestFailure } from '../../../../lib/db';
import { regenerateSavedLinksPage } from '../../../../lib/saved-links';

const N8N_URL = process.env.N8N_URL ?? 'http://n8n:5678';
const N8N_INGEST_WEBHOOK_PATH = '/webhook/ingest';
const N8N_TIMEOUT_MS = 5000;

interface UrlIngestRequest {
  urls: unknown;
}

function isValidHttpUrl(raw: string): boolean {
  try {
    const u = new URL(raw);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

async function triggerN8n(payload: {
  source_id: string;
  source_type: 'url' | 'file';
  source_ref: string;
}): Promise<void> {
  const controller = new AbortController();
  const t = setTimeout(() => controller.abort(), N8N_TIMEOUT_MS);
  try {
    const res = await fetch(`${N8N_URL}${N8N_INGEST_WEBHOOK_PATH}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    if (!res.ok) {
      throw new Error(`n8n webhook returned ${res.status}`);
    }
  } finally {
    clearTimeout(t);
  }
}

export async function POST(request: Request) {
  // Phase 1 — parse and validate input (async-safe, no DB writes yet).
  let body: UrlIngestRequest;
  try {
    body = (await request.json()) as UrlIngestRequest;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (!Array.isArray(body.urls) || body.urls.length === 0) {
    return NextResponse.json({ error: 'urls must be a non-empty array' }, { status: 422 });
  }
  if (body.urls.length > 50) {
    return NextResponse.json({ error: 'max 50 urls per request' }, { status: 422 });
  }

  const urls: string[] = [];
  for (const raw of body.urls) {
    if (typeof raw !== 'string') {
      return NextResponse.json({ error: 'every url must be a string' }, { status: 422 });
    }
    const trimmed = raw.trim();
    if (!isValidHttpUrl(trimmed)) {
      return NextResponse.json({ error: `invalid url: ${trimmed}` }, { status: 422 });
    }
    urls.push(trimmed);
  }

  // Phase 2 — per-url ingest: assign source_id, log accepted, fire webhook.
  // Activity log writes are individual INSERTs (not in a single transaction)
  // because we want each accepted row visible to the feed poller even if a
  // later webhook call fails.
  const db = getDb();
  const accepted_source_ids: string[] = [];
  const failed_urls: { url: string; error: string }[] = [];

  for (const url of urls) {
    const source_id = randomUUID();
    // Log "accepted" BEFORE firing the webhook so the feed shows it as
    // queued even if the webhook times out.
    insertActivity({
      action_type: 'ingest_accepted',
      source_id,
      details: { source_type: 'url', source_ref: url },
    });

    try {
      await triggerN8n({ source_id, source_type: 'url', source_ref: url });
      accepted_source_ids.push(source_id);
    } catch (e) {
      const error = e instanceof Error ? e.message : 'unknown';
      // Log the failure so the feed UI shows it; don't throw.
      insertActivity({
        action_type: 'ingest_failed',
        source_id,
        details: { node: 'next_ingest_url', error },
      });
      failed_urls.push({ url, error });
      // Persist the URL so it appears on the Saved Links wiki page.
      // No title or date known at this point — just the URL.
      insertIngestFailure({
        failure_id: randomUUID(),
        source_url: url,
        source_type: 'url',
        error,
      });
      void regenerateSavedLinksPage().catch(() => {});
    }
  }

  // suppress unused-var lint on db — we wanted it hot-open even though the
  // inserts above go through the shared helper.
  void db;

  if (accepted_source_ids.length === 0) {
    return NextResponse.json(
      {
        error: 'all n8n webhook calls failed',
        failed: failed_urls,
      },
      { status: 502 }
    );
  }

  return NextResponse.json(
    {
      accepted: accepted_source_ids.length,
      source_ids: accepted_source_ids,
      failed: failed_urls.length > 0 ? failed_urls : undefined,
    },
    { status: 202 }
  );
}
