import { NextResponse } from 'next/server';
import { getBacklinks, getLinkedPages, getPage, getSource, readPageMarkdown } from '@/lib/db';
import { citationsToText } from '@/lib/citations';
import { getNumberedSources, getSourceTitleSet } from '@/lib/page-sources';
import { displayPageBody } from '@/lib/page-sections';
import { getPageConnections } from '@/lib/relations';
import { listPageDisagreements } from '@/lib/disagreements';
import { pageDisagreementsOut } from '@/lib/disagreement-view';

/** GET /api/wiki/[page_id]/data — full page JSON for the Kompl MCP server.
 *
 *  `content` is the page body as the page view shows it (frontmatter and
 *  legacy wrappers removed) with source citations as plain [n] markers;
 *  `sources` is the matching numbered list, one entry per source (cited
 *  sources first, in citation order), with its address and date, so the
 *  numbers agree with the page view. `connections` is the page's connections
 *  card (lib/relations.ts getPageConnections: typed relations with their
 *  evidence, then the other wikilinked pages). `links` are the pages this
 *  page links to and `backlinks` the pages linking here; both stay for MCP
 *  builds that predate `connections`. `disagreements` are the ones Kompl
 *  recorded on the page (lib/disagreements.ts), the owner's dismissals left
 *  out, each source numbered like `sources`. Page metadata that the
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
  const body = displayPageBody(readPageMarkdown(page_id) ?? '', page.page_type);
  const { markdown: content, order } = citationsToText(body, (t) => sourceTitles.has(t.toLowerCase()));

  const sources = getNumberedSources(page_id, order).map((s) => ({
    n: s.n,
    source_id: s.source_id,
    title: s.title ?? 'Source no longer in the wiki',
    contribution_type: s.contribution_type ?? 'cited',
    source_url: s.source_url,
    date: s.date,
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
    connections: getPageConnections(page_id),
    disagreements: pageDisagreementsOut(listPageDisagreements(page_id), sources, (id) => getSource(id)?.title ?? null),
    links: getLinkedPages(page_id),
    backlinks: getBacklinks(page_id)
      .filter((p) => p.page_id !== page_id)
      .map((p) => ({ page_id: p.page_id, title: p.title }))
      .sort((a, b) => a.title.localeCompare(b.title)),
  });
}
