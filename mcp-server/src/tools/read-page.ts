import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiResult, KomplClient } from '../kompl-client.js';
import { failure, READ_ONLY, text } from '../result.js';
import type { PageData, PageLink, PageSource, RelatedPages } from '../types.js';

/** Long link lists are cut here; the rest is counted. */
const MAX_LINKS = 20;

// GET /api/wiki/{page_id}/data → page metadata, markdown body, numbered
// sources, links; plus /related when asked.
export function registerReadPage(server: McpServer, client: KomplClient): void {
  server.registerTool(
    'read_page',
    {
      title: 'Read page',
      description:
        'Read a Kompl wiki page by its page_id (from search_wiki): the full text with [n] citations, the numbered ' +
        'sources they refer to (with address and date), and the pages it links to and from.',
      inputSchema: {
        page_id: z.string().describe('The page_id from search results'),
        include_related: z
          .boolean()
          .default(false)
          .describe('Also list pages similar in meaning (default false)'),
      },
      annotations: READ_ONLY,
    },
    async ({ page_id, include_related }) => {
      const path = `/api/wiki/${encodeURIComponent(page_id)}`;
      const [res, related] = await Promise.all([
        client.get<PageData>(`${path}/data`),
        include_related ? client.get<RelatedPages>(`${path}/related`) : Promise.resolve(null),
      ]);
      if (!res.ok) {
        return res.status === 404
          ? failure(`Page not found: ${page_id}. Use search_wiki to find page ids.`)
          : failure(`Failed to load page ${page_id}: ${res.message}`);
      }
      const page = res.data;
      const lines = [
        `# ${page.title}`,
        `Type: ${page.page_type}${page.category ? ` | Category: ${page.category}` : ''} | Sources: ${page.source_count}`,
        `Last updated: ${page.last_updated}`,
        ``,
        page.content || '(no content)',
        ``,
        `---`,
        `**Sources** (the [n] markers above refer to these):`,
        page.sources.length ? page.sources.map(sourceLine).join('\n') : '  (none)',
      ];
      if (page.links?.length) lines.push(`**Links to:** ${linkList(page.links)}`);
      if (page.backlinks?.length) lines.push(`**Linked from:** ${linkList(page.backlinks)}`);
      if (related) lines.push(relatedLine(related));
      if (page.sources.some((s) => s.n)) {
        lines.push('', 'To check what a source says, call read_source with this page_id and n.');
      }
      return text(lines.join('\n'));
    }
  );
}

/** Newer apps number the sources to match the [n] markers; older ones send an unnumbered list. */
function sourceLine(s: PageSource): string {
  if (!s.n) return `  - ${s.title} (${s.contribution_type})`;
  // The date is when the page was last compiled from this source, not when it was published.
  const details = [s.source_url, s.date ? `compiled ${s.date.slice(0, 10)}` : null].filter(Boolean).join(' · ');
  return `  [${s.n}] ${s.title}${details ? ` — ${details}` : ''}`;
}

function linkList(links: PageLink[]): string {
  const shown = links.slice(0, MAX_LINKS).map((l) => `${l.title} (\`${l.page_id}\`)`);
  const more = links.length - shown.length;
  return shown.join(', ') + (more > 0 ? `, and ${more} more` : '');
}

function relatedLine(related: ApiResult<RelatedPages>): string {
  if (!related.ok) return `**Related:** unavailable (${related.message})`;
  const data = related.data;
  if (!data.enabled) return '**Related:** shown once the wiki has enough sources (the minimum is set in Settings).';
  if (!data.items.length) return '**Related:** no closely similar pages.';
  return `**Related:** ${linkList(data.items)}`;
}
