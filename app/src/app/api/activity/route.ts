/**
 * GET  /api/activity?since=<iso>   — poll endpoint used by the feed UI
 * POST /api/activity                — write endpoint used by n8n's
 *                                     error-handler workflow
 *
 * GET response:
 *   {items: ActivityRow[], count: number}
 *
 * POST request:
 *   {action_type: string, source_id?: string|null, details?: object|null}
 * POST response:
 *   {id: number}
 */

import { NextResponse } from 'next/server';

import { getRecentActivity, insertActivity } from '../../../lib/db';

export async function GET(request: Request) {
  const url = new URL(request.url);
  const since = url.searchParams.get('since');
  const limitRaw = url.searchParams.get('limit');
  const limit = limitRaw ? Math.min(Math.max(parseInt(limitRaw, 10) || 100, 1), 500) : 100;

  const items = getRecentActivity(since, limit);
  return NextResponse.json({ items, count: items.length });
}

interface ActivityWriteBody {
  action_type?: unknown;
  source_id?: unknown;
  details?: unknown;
}

export async function POST(request: Request) {
  let body: ActivityWriteBody;
  try {
    body = (await request.json()) as ActivityWriteBody;
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (typeof body.action_type !== 'string' || !body.action_type) {
    return NextResponse.json({ error: 'action_type must be non-empty string' }, { status: 422 });
  }

  let source_id: string | null = null;
  if (body.source_id !== undefined && body.source_id !== null) {
    if (typeof body.source_id !== 'string') {
      return NextResponse.json({ error: 'source_id must be string or null' }, { status: 422 });
    }
    source_id = body.source_id;
  }

  let details: Record<string, unknown> | null = null;
  if (body.details !== undefined && body.details !== null) {
    if (typeof body.details !== 'object' || Array.isArray(body.details)) {
      return NextResponse.json({ error: 'details must be object or null' }, { status: 422 });
    }
    details = body.details as Record<string, unknown>;
  }

  const id = insertActivity({
    action_type: body.action_type,
    source_id,
    details,
  });

  return NextResponse.json({ id }, { status: 201 });
}
