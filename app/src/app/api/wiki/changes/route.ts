/**
 * GET /api/wiki/changes — what changed, for MCP recent_changes. One of:
 *
 *   ?page_id=X     one page: its compiles, events and the sections that
 *                  differ from its previous version (lib/page-history.ts)
 *   ?session_id=X  one compile session: progress, each staged item's fate,
 *                  sources added and pages changed (lib/wiki-changes.ts)
 *   ?since=T       everything since T (any SQLite datetime, e.g. ISO)
 *   ?days=N        everything in the last N days (default 7, max 365)
 *
 * &limit=N caps each list (default 20, max 100); totals count everything.
 * Errors: 400 invalid_since, 404 page_not_found / session_not_found.
 * Plain reads; no LLM.
 */

import { NextResponse } from 'next/server';
import { getDb } from '@/lib/db';
import { pageHistory } from '@/lib/page-history';
import { changesForSession, changesSince } from '@/lib/wiki-changes';

export const dynamic = 'force-dynamic';

const DEFAULT_DAYS = 7;
const MAX_DAYS = 365;
const DEFAULT_LIMIT = 20;
const MAX_LIMIT = 100;

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const limit = clampInt(params.get('limit'), DEFAULT_LIMIT, 1, MAX_LIMIT);

  const pageId = params.get('page_id')?.trim();
  if (pageId) {
    const history = pageHistory(pageId, limit);
    return history
      ? NextResponse.json({ mode: 'page', ...history })
      : NextResponse.json({ error: 'page_not_found', message: `No page ${pageId}.` }, { status: 404 });
  }

  const sessionId = params.get('session_id')?.trim();
  if (sessionId) {
    const session = changesForSession(sessionId, limit);
    return session
      ? NextResponse.json({ mode: 'session', ...session })
      : NextResponse.json({ error: 'session_not_found', message: `No compile session ${sessionId}.` }, { status: 404 });
  }

  // Resolve the window to a normalized SQLite datetime once, so every list
  // compares against the same instant.
  const sinceParam = params.get('since')?.trim();
  const days = clampInt(params.get('days'), DEFAULT_DAYS, 1, MAX_DAYS);
  const row = sinceParam
    ? (getDb().prepare('SELECT datetime(?) AS since').get(sinceParam) as { since: string | null })
    : (getDb().prepare("SELECT datetime('now', ?) AS since").get(`-${days} days`) as { since: string | null });
  if (!row.since) {
    return NextResponse.json(
      { error: 'invalid_since', message: `"${sinceParam}" is not a date or time.` },
      { status: 400 }
    );
  }
  return NextResponse.json({ mode: 'since', ...changesSince(row.since, limit) });
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : Math.min(Math.max(n, min), max);
}
