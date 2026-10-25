import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KomplClient } from '../kompl-client.js';
import { fence } from '../fence.js';
import { clip } from '../format.js';
import { failure, READ_ONLY, text } from '../result.js';
import type { PageLink, ResearchConnection, ResearchPack } from '../types.js';

/** Characters of Kompl's one-line summary of a connection (as in read_page). */
const MAX_SENTENCE = 160;
/** A source's sentence is often longer than Kompl's summary of it. */
const MAX_QUOTE = 240;

// GET /api/wiki/research?topic=&detail= → one topic pack, sources numbered across pages
export function registerResearchTopic(server: McpServer, client: KomplClient): void {
  server.registerTool(
    'research_topic',
    {
      title: 'Research topic',
      description:
        "Brief yourself on a topic from the user's Kompl wiki in one call: the most relevant pages with their " +
        "summaries and key cited lines, how those pages connect (each relation with its sources and the " +
        "source's own sentence, marked quoted, or Kompl's one-line summary of it), ONE numbered " +
        'source list shared by all of them (with addresses), what the pages record as disputed, and gaps ' +
        '(names with no page, pages resting on one source). Use for ' +
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
  const head = [`# Topic: ${pack.topic}`];
  if (pack.degraded) head.push('(Meaning-based search is unavailable right now; pages were found by keywords only.)');

  // Everything read from the wiki goes inside the fence (fence.ts).
  const out: string[] = [];
  pack.pages.forEach((p, i) => {
    const flags = [p.thin ? 'rests on one source' : null].filter(Boolean);
    out.push(
      ...(i > 0 ? [''] : []),
      `## ${i + 1}. ${p.title} (${p.page_type}${p.category ? `, ${p.category}` : ''}) — \`${p.page_id}\``,
      `${baseUrl}${p.path}${flags.length ? ` · ${flags.join(', ')}` : ''}`
    );
    if (p.summary) out.push(p.summary);
    for (const line of p.key_lines) out.push(`- ${line}`);
    if (p.disputes.length) out.push(`Disputed here: ${p.disputes.join('; ')}`);
  });

  // Older apps send no connections.
  if (pack.connections?.length) {
    const inPack = new Set(pack.pages.map((p) => p.page_id));
    out.push('', '**How these pages connect:**');
    for (const c of pack.connections) out.push(connectionLine(c, inPack));
  }

  if (pack.sources.length) {
    out.push('', '**Sources** (numbers are shared by all pages above):');
    for (const s of pack.sources) {
      // Notes and files have no web address: link to the source in the app.
      const address = s.source_url ?? `${baseUrl}${s.path}`;
      // The pack's [n] is not the page's own [n]: read_source needs the id.
      const details = [address, s.date_ingested ? `added ${s.date_ingested.slice(0, 10)}` : null, `source_id \`${s.source_id}\``];
      out.push(`[${s.n}] ${s.title} — ${details.filter(Boolean).join(' · ')}`);
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
  return [
    ...head,
    '',
    fence(out.join('\n')),
    '',
    "Read a page in full with read_page. Check a source with read_source with the source_id listed above: these [n] numbers are this brief's own, not the pages'.",
  ].join('\n');
}

/**
 * "- Bitcoin uses Proof of work [1][3] · 4 sources · quoted: "Bitcoin relies on proof of work.""
 * The label reads from `from`; a page outside the pack carries its page_id.
 * A quote is the first listed source's own sentence, checked against it at
 * extraction; without one, Kompl's own summary of the relation, written
 * from that source, labelled as such.
 */
function connectionLine(c: ResearchConnection, inPack: Set<string>): string {
  const end = (p: PageLink) => (inPack.has(p.page_id) ? p.title : `${p.title} (\`${p.page_id}\`)`);
  const relation = c.label.charAt(0).toLowerCase() + c.label.slice(1);
  const parts = [`- ${end(c.from)} ${relation} ${end(c.to)}`];
  if (c.sources.length) parts.push(c.sources.map((n) => `[${n}]`).join(''));
  if (c.source_count > 1) parts.push(`· ${c.source_count} sources`);
  if (c.quote) parts.push(`· quoted: "${clip(c.quote, MAX_QUOTE)}"`);
  else if (c.sentence) parts.push(`· Kompl's summary: ${clip(c.sentence, MAX_SENTENCE)}`);
  if (c.outdated) parts.push(`· may be outdated: [${c.outdated.source}] says otherwise (changed over time: ${clip(c.outdated.topic, MAX_SENTENCE)})`);
  if (c.direction_dispute?.sources.length) {
    const refs = c.direction_dispute.sources.map((n) => `[${n}]`).join('');
    parts.push(`· sources disagree on direction: ${refs} read it as "${end(c.from)} ${c.direction_dispute.label.toLowerCase()} ${end(c.to)}"`);
  }
  return parts.join(' ');
}
