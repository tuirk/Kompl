import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KomplClient } from '../kompl-client.js';
import { failure, READ_ONLY, text } from '../result.js';
import type { ResearchPack } from '../types.js';

// GET /api/wiki/research?topic=&detail= → one topic pack, sources numbered across pages
export function registerResearchTopic(server: McpServer, client: KomplClient): void {
  server.registerTool(
    'research_topic',
    {
      title: 'Research topic',
      description:
        "Brief yourself on a topic from the user's Kompl wiki in one call: the most relevant pages with their " +
        'summaries and key cited lines, ONE numbered source list shared by all of them (with addresses), what ' +
        'the pages record as disputed, and gaps (names with no page, pages resting on one source). Use for ' +
        '"tell me about X" or "brief me on X"; for a specific lookup use search_wiki and read_page.',
      inputSchema: {
        topic: z.string().describe('The topic, question or name to research'),
        detail: z
          .enum(['brief', 'full'])
          .default('brief')
          .describe('brief: 5 pages × 3 lines (default); full: 10 pages × 6 lines'),
      },
      annotations: READ_ONLY,
    },
    async ({ topic, detail }) => {
      const res = await client.get<ResearchPack>('/api/wiki/research', { topic, detail });
      if (!res.ok) {
        if (res.status === 404 && res.message === 'HTTP 404') {
          return failure("This Kompl app can't build topic packs yet. Run `kompl update`, or use search_wiki and read_page.");
        }
        return failure(`Research failed: ${res.message}`);
      }
      return text(format(res.data, client.baseUrl));
    }
  );
}

function format(pack: ResearchPack, baseUrl: string): string {
  if (!pack.pages.length) {
    return pack.degraded
      ? `Keyword search found no pages on "${pack.topic}", and meaning-based search is unavailable right now, so Kompl may still have something. Try search_wiki with other words, or again later.`
      : `Kompl has no pages on "${pack.topic}". Say so rather than answering from general knowledge.`;
  }
  const out = [`# Topic: ${pack.topic}`];
  if (pack.degraded) out.push('(Meaning-based search is unavailable right now; pages were found by keywords only.)');

  pack.pages.forEach((p, i) => {
    const flags = [p.thin ? 'rests on one source' : null].filter(Boolean);
    out.push(
      '',
      `## ${i + 1}. ${p.title} (${p.page_type}${p.category ? `, ${p.category}` : ''}) — \`${p.page_id}\``,
      `${baseUrl}${p.path}${flags.length ? ` · ${flags.join(', ')}` : ''}`
    );
    if (p.summary) out.push(p.summary);
    for (const line of p.key_lines) out.push(`- ${line}`);
    if (p.disputes.length) out.push(`Disputed here: ${p.disputes.join('; ')}`);
  });

  if (pack.sources.length) {
    out.push('', '**Sources** (numbers are shared by all pages above):');
    for (const s of pack.sources) {
      // Notes and files have no web address: link to the source in the app.
      const address = s.source_url ?? `${baseUrl}${s.path}`;
      const details = [address, s.date_ingested ? `added ${s.date_ingested.slice(0, 10)}` : null].filter(Boolean);
      out.push(`[${s.n}] ${s.title}${details.length ? ` — ${details.join(' · ')}` : ''}`);
    }
  }

  const gaps: string[] = [];
  if (pack.missing_pages.length) {
    gaps.push(`named in several sources but no page: ${pack.missing_pages.map((m) => `${m.name} (${m.mentions})`).join(', ')}`);
  }
  const thin = pack.pages.filter((p) => p.thin);
  if (thin.length) gaps.push(`resting on one source: ${thin.map((p) => p.title).join(', ')}`);
  if (gaps.length) out.push('', `**Gaps:** ${gaps.join('; ')}.`);

  if (pack.more_pages.length) {
    out.push('', `**Also relevant:** ${pack.more_pages.map((p) => `${p.title} (\`${p.page_id}\`)`).join(', ')}`);
  }
  out.push('', 'Read a page in full with read_page; check a source with read_source.');
  return out.join('\n');
}
