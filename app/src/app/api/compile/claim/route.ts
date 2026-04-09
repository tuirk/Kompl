/**
 * POST /api/compile/claim
 *
 * Called BY the n8n compile-drain Schedule Trigger poller (internal network).
 * Atomically claims one pending source for compilation.
 *
 * Returns {source_id} if a source was claimed, or {status: "nothing_pending"}
 * if there is nothing eligible right now.
 *
 * The claim is atomic via better-sqlite3's sync transaction: a LIMIT 1 fetch
 * followed by an UPDATE that re-checks compile_status = 'pending'. Because
 * better-sqlite3 is synchronous and Next.js is single-writer, no two callers
 * can claim the same row.
 *
 * Request: {} (empty body, or any body — ignored)
 * Response:
 *   {source_id: string}              — claimed, proceed to compile
 *   {status: "nothing_pending"}      — nothing to do, n8n IF node exits
 */

import { NextResponse } from 'next/server';

import { claimCompileSource } from '../../../../lib/db';

export async function POST() {
  const source_id = claimCompileSource();

  if (!source_id) {
    return NextResponse.json({ status: 'nothing_pending' }, { status: 200 });
  }

  return NextResponse.json({ source_id }, { status: 200 });
}
