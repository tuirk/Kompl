import { NextResponse } from 'next/server';
import { getPage, readPageMarkdown } from '@/lib/db';
import { stripFrontmatter } from '@/lib/markdown';
import { citationsToText } from '@/lib/citations';
import { getNumberedSources, getSourceTitleSet } from '@/lib/page-sources';

/** GET /api/wiki/[page_id]/data — full page JSON for the Kompl MCP server.
 *
 *  `content` is the page body (frontmatter removed) with source citations as
 *  plain [n] markers; `sources` is the matching numbered list, one entry per
 *  source (cited sources first, in citation order). Page metadata that the
 *  frontmatter duplicates is in the top-level fields. */
export async function GET(
  _request: Request,
  { params }: { params: Promise<{ page_id: string }> }
) {
  const { page_id } = await params;
  const page = getPage(page_id);
  if (!page) {
    return NextResponse.json({ error: 'Page not found' }, { status: 404 });
  }

  const sourceTitles = getSourceTitleSet();
  const body = stripFrontmatter(readPageMarkdown(page_id) ?? '');
  const { markdown: content, order } = citationsToText(body, (t) => sourceTitles.has(t.toLowerCase()));

  const sources = getNumberedSources(page_id, order).map((s) => ({
    n: s.n,
    source_id: s.source_id,
    title: s.title ?? 'Source no longer in the wiki',
    contribution_type: s.contribution_type ?? 'cited',
  }));

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
