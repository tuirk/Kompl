/**
 * GET /api/wiki/[page_id]/previous
 *
 * Returns the previous version markdown content for a page.
 * The previous_content_path column stores the versioned gzip path written
 * by file_store.py (e.g. /data/pages/{page_id}.{timestamp}.md.gz).
 *
 * Returns 404 if the page has no previous version.
 */

import { NextResponse } from 'next/server';
import fs from 'node:fs';
import zlib from 'node:zlib';
import { getPage } from '../../../../../lib/db';

interface RouteContext {
  params: Promise<{ page_id: string }>;
}

export async function GET(_request: Request, { params }: RouteContext) {
  const { page_id } = await params;

  const page = getPage(page_id);
  if (!page) {
    return NextResponse.json({ error: 'not_found' }, { status: 404 });
  }

  if (!page.previous_content_path) {
    return NextResponse.json({ error: 'no_previous_version' }, { status: 404 });
  }

  if (!fs.existsSync(page.previous_content_path)) {
    return NextResponse.json({ error: 'file_missing' }, { status: 404 });
  }

  try {
    const gzipped = fs.readFileSync(page.previous_content_path);
    const content = zlib.gunzipSync(gzipped).toString('utf-8');
    return NextResponse.json({ content });
  } catch {
    return NextResponse.json({ error: 'read_failed' }, { status: 500 });
  }
}
