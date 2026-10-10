/**
 * GET /api/sources/[source_id]/content[?q=<query>&k=N][&offset=N]
 *
 * A source's stored text (what Kompl compiled from), for the MCP read_source
 * tool, so an agent can check a citation against the original.
 *
 *   With q: the k (default 3, max 10) passages that best match the query,
 *           ranked by BM25 (lib/passages.ts) — mode 'passages'.
 *   Without q: up to WINDOW_CHARS characters from offset, plus next_offset
 *           (null at the end) — mode 'text'.
 *
 * No LLM, no NLP service. Errors: 400 invalid_source_id, 404 not_found,
 * 404 no_text (the source's stored text is missing).
 */

import { NextResponse } from 'next/server';
import { getSource, readRawMarkdown } from '@/lib/db';
import { rankPassages, safeCut, splitPassages } from '@/lib/passages';
import { isSafeId } from '@/lib/safe-paths';

export const dynamic = 'force-dynamic';

const WINDOW_CHARS = 8_000;
const DEFAULT_PASSAGES = 3;
const MAX_PASSAGES = 10;

interface RouteContext {
  params: Promise<{ source_id: string }>;
}

export async function GET(request: Request, { params }: RouteContext) {
  const { source_id } = await params;
  if (!isSafeId(source_id)) {
    return NextResponse.json({ error: 'invalid_source_id', message: 'Invalid source id.' }, { status: 400 });
  }
  const source = getSource(source_id);
  if (!source) {
    return NextResponse.json({ error: 'not_found', message: `No source ${source_id}.` }, { status: 404 });
  }
  const markdown = readRawMarkdown(source_id);
  if (markdown === null) {
    return NextResponse.json(
      { error: 'no_text', message: "This source's stored text is missing." },
      { status: 404 }
    );
  }

  const meta = {
    source_id: source.source_id,
    title: source.title,
    source_type: source.source_type,
    source_url: source.source_url,
    status: source.status,
    date_ingested: source.date_ingested,
    total_chars: markdown.length,
  };

  const { searchParams } = new URL(request.url);
  const query = searchParams.get('q')?.trim();
  if (query) {
    const k = clampInt(searchParams.get('k'), DEFAULT_PASSAGES, 1, MAX_PASSAGES);
    const passages = rankPassages(query, splitPassages(markdown), k).map(({ text, heading, start }) => ({
      text,
      heading,
      start,
    }));
    return NextResponse.json({ ...meta, mode: 'passages', query, passages });
  }

  const offset = clampInt(searchParams.get('offset'), 0, 0, markdown.length);
  const end = safeCut(markdown, Math.min(offset + WINDOW_CHARS, markdown.length));
  return NextResponse.json({
    ...meta,
    mode: 'text',
    offset,
    text: markdown.slice(offset, end),
    next_offset: end < markdown.length ? end : null,
  });
}

function clampInt(raw: string | null, fallback: number, min: number, max: number): number {
  const n = raw === null ? NaN : parseInt(raw, 10);
  return Number.isNaN(n) ? fallback : Math.min(Math.max(n, min), max);
}
