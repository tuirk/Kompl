import { NextResponse } from 'next/server';
import { getDb, getPage, readPageMarkdown } from '@/lib/db';

/** GET /api/wiki/[page_id]/data — full page JSON for the Kompl MCP server.
 *  Returns page metadata, decompressed markdown content, and provenance sources. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ page_id: string }> }
) {
  const { page_id } = await params;
  const page = getPage(page_id);
  if (!page) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }

  const content = readPageMarkdown(page_id) ?? '';

  const sources = getDb()
    .prepare(
      `SELECT s.source_id, s.title, pr.contribution_type
         FROM provenance pr
         JOIN sources s ON s.source_id = pr.source_id
        WHERE pr.page_id = ?`
    )
    .all(page_id) as Array<{ source_id: string; title: string; contribution_type: string }>;

  return NextResponse.json({
    page_id: page.page_id,
    title: page.title,
    page_type: page.page_type,
    category: page.category,
    summary: page.summary,
    source_count: page.source_count,
    last_updated: page.last_updated,
    content,
    sources,
  });
}
