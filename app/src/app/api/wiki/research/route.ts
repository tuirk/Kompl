/**
 * GET /api/wiki/research?topic=<topic>[&detail=brief|full]
 *
 * One-call topic pack for MCP research_topic (lib/research.ts): the most
 * relevant pages with summaries and key cited lines, one source list
 * numbered across them, the disputes they record, gaps around the topic,
 * and `connections`: typed relations touching those pages (at most 12,
 * strongest first), each citing the shared source numbers. Page and source
 * links are relative app paths.
 *
 * brief (default): 5 pages × 3 lines; full: 10 pages × 6 lines.
 * Errors: 400 missing_topic. No LLM; the vector search behind hybrid search
 * is the only call out.
 */

import { NextResponse } from 'next/server';
import { researchTopic, type ResearchDetail } from '@/lib/research';

export const dynamic = 'force-dynamic';

export async function GET(request: Request) {
  const params = new URL(request.url).searchParams;
  const topic = params.get('topic')?.trim();
  if (!topic) {
    return NextResponse.json({ error: 'missing_topic', message: 'Give a topic to research.' }, { status: 400 });
  }
  const detail: ResearchDetail = params.get('detail') === 'full' ? 'full' : 'brief';
  const pack = await researchTopic(topic, detail);
  return NextResponse.json({
    ...pack,
    detail,
    pages: pack.pages.map((p) => ({ ...p, path: `/wiki/${p.page_id}` })),
    sources: pack.sources.map((s) => ({ ...s, path: `/source/${s.source_id}` })),
  });
}
