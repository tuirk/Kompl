/**
 * POST /api/compile/schema
 *
 * Part 2c-i — Schema Bootstrap.
 *
 * Only runs if /data/schema.md does not yet exist (first compile ever).
 * Reads committed page_plans for the session, calls /pipeline/generate-schema
 * to produce a wiki schema document, then writes it to /data/schema.md.
 *
 * The schema is passed as standing instructions to all future draft-page
 * and crossref calls so the LLM maintains consistent conventions.
 *
 * Request:  { session_id: string }
 * Response: { session_id, schema_generated: boolean, path?: string }
 */

import { NextResponse } from 'next/server';
import { getPagePlansByStatus } from '../../../../lib/db';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';
const SCHEMA_PATH = '/data/schema.md';

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { session_id } = rawBody as { session_id?: string };
  if (typeof session_id !== 'string' || !session_id.trim()) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }

  // Check if schema already exists — skip if it does
  const existsRes = await fetch(`${NLP_SERVICE_URL}/storage/file-exists`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: SCHEMA_PATH }),
    signal: AbortSignal.timeout(10_000),
  }).catch(() => null);

  if (existsRes?.ok) {
    const { exists } = (await existsRes.json()) as { exists: boolean };
    if (exists) {
      return NextResponse.json(
        { session_id, schema_generated: false, reason: 'already_exists' },
        { status: 200 }
      );
    }
  }

  // Get committed pages for this session
  const committedPlans = getPagePlansByStatus(session_id, 'committed');
  if (committedPlans.length === 0) {
    return NextResponse.json(
      { error: 'no_committed_pages', detail: 'Run /api/compile/commit first.' },
      { status: 400 }
    );
  }

  const pagesSummary = committedPlans.map((p) => ({
    title: p.title,
    page_type: p.page_type,
    category: (() => {
      // Extract category from draft_content frontmatter if available
      if (!p.draft_content) return null;
      const m = p.draft_content.match(/^category:\s*["']?(.+?)["']?\s*$/m);
      return m?.[1]?.trim() ?? null;
    })(),
  }));

  // Call generate-schema
  const genRes = await fetch(`${NLP_SERVICE_URL}/pipeline/generate-schema`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pages: pagesSummary }),
    signal: AbortSignal.timeout(120_000),
  });

  if (!genRes.ok) {
    const detail = await genRes.text().catch(() => '');
    if (genRes.status === 429) return NextResponse.json({ error: 'llm_rate_limited' }, { status: 429 });
    if (genRes.status === 503) return NextResponse.json({ error: 'daily_cost_ceiling' }, { status: 503 });
    return NextResponse.json({ error: `generate_schema_failed: ${genRes.status} ${detail}` }, { status: 500 });
  }

  const { markdown } = (await genRes.json()) as { markdown: string };

  // Write to /data/schema.md
  const writeRes = await fetch(`${NLP_SERVICE_URL}/storage/write-file`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ path: SCHEMA_PATH, content: markdown }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!writeRes.ok) {
    const detail = await writeRes.text().catch(() => '');
    return NextResponse.json({ error: `schema_write_failed: ${detail}` }, { status: 500 });
  }

  const { path } = (await writeRes.json()) as { path: string };

  return NextResponse.json({ session_id, schema_generated: true, path }, { status: 200 });
}
