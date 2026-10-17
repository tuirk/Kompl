import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { ApiResult, KomplClient } from '../kompl-client.js';
import { clip } from '../format.js';
import { failure, READ_ONLY, text } from '../result.js';
import type { ConnectionEvidence, ConnectionItem, PageConnections, PageData, PageLink, PageSource, RelatedPages } from '../types.js';

/** Long link lists are cut here; the rest is counted. */
const MAX_LINKS = 20;
/** Connections listed in full, one per line; the pages among the rest are named. */
const MAX_CONNECTIONS = 15;
/** The weak relation: listed in full only after every specific one. */
const RELATED_TO = 'related_to';
/** Characters of a connection's evidence sentence. */
const MAX_SENTENCE = 160;

// GET /api/wiki/{page_id}/data → page metadata, markdown body, numbered
// sources, connections (newer apps) or links; plus /related when asked.
export function registerReadPage(server: McpServer, client: KomplClient): void {
  server.registerTool(
    'read_page',
    {
      title: 'Read page',
      description:
        'Read a Kompl wiki page by its page_id (from search_wiki): the full text with [n] citations, the numbered ' +
        'sources they refer to (with address and date), how the page connects to others (each relation, such as ' +
        'uses or part of, with the source that says so), and the pages it links to and from.',
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
      if (page.connections) {
        lines.push(...connectionLines(page.connections, page.sources));
      } else {
        // Apps from before connections: the plain link lists.
        if (page.links?.length) lines.push(`**Links to:** ${linkList(page.links)}`);
        if (page.backlinks?.length) lines.push(`**Linked from:** ${linkList(page.backlinks)}`);
      }
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

/**
 * The strongest typed connections in full, one line each in the app's label
 * order; the pages among the rest by name (so read_page never drops a page
 * the plain link lists named); then the pages linked with no typed relation.
 */
function connectionLines(connections: PageConnections, sources: PageSource[]): string[] {
  const numbered = new Map<string, number>();
  for (const s of sources) if (s.n) numbered.set(s.source_id.toLowerCase(), s.n);
  const items = connections.groups.flatMap((g) => g.items.map((item) => ({ label: g.label, item })));
  const full = strongest(items.map(({ item }) => item), MAX_CONNECTIONS);
  const lines: string[] = [];
  if (items.length) {
    lines.push('**Connections:**');
    for (const { label, item } of items) if (full.has(item)) lines.push(connectionLine(label, item, numbered));
    const rest = items.filter(({ item }) => !full.has(item)).map(({ item }) => item);
    if (rest.length) lines.push(moreLine(rest, full));
  }
  if (connections.linked_only.length) lines.push(`**Also linked:** ${linkList(connections.linked_only)}`);
  if (!lines.length) lines.push('**Connections:** none yet.');
  return lines;
}

/** The `count` strongest: specific relations before "Related to", then most sources; ties keep the app's order. */
function strongest(items: ConnectionItem[], count: number): Set<ConnectionItem> {
  const weak = (item: ConnectionItem) => (item.type === RELATED_TO ? 1 : 0);
  const ranked = items
    .map((item, index) => ({ item, index }))
    .sort((x, y) => weak(x.item) - weak(y.item) || y.item.source_count - x.item.source_count || x.index - y.index);
  return new Set(ranked.slice(0, count).map(({ item }) => item));
}

/** "+4 more, among them Vilnius Cathedral (`vilnius-cathedral`)": pages not named above; names with no page are only counted. */
function moreLine(rest: ConnectionItem[], full: Set<ConnectionItem>): string {
  const named = new Set([...full].map((item) => item.page_id));
  const pages = new Map<string, PageLink>();
  for (const { page_id, title } of rest) {
    if (page_id && !named.has(page_id) && !pages.has(page_id)) pages.set(page_id, { page_id, title });
  }
  return `+${rest.length} more${pages.size ? `, among them ${linkList([...pages.values()])}` : ''}`;
}

/** "- Uses: Proof of work (`pow`) — Bitcoin uses proof of work. [2] · 3 sources" */
function connectionLine(label: string, item: ConnectionItem, numbered: Map<string, number>): string {
  const parts = [`- ${label}: ${item.title} ${item.page_id ? `(\`${item.page_id}\`)` : '(no page)'}`];
  const evidence = pickEvidence(item.evidence, numbered);
  if (evidence?.sentence) parts.push(`— ${clip(evidence.sentence, MAX_SENTENCE)}`);
  if (evidence) parts.push(sourceRef(evidence, numbered));
  if (item.source_count > 1) parts.push(`· ${item.source_count} sources`);
  return parts.join(' ');
}

/** A sentence from a source the page cites (so read_source can check it), else any sentence, else the first source. */
function pickEvidence(evidence: ConnectionEvidence[], numbered: Map<string, number>): ConnectionEvidence | undefined {
  return (
    evidence.find((e) => e.sentence && numbered.has(e.source_id.toLowerCase())) ??
    evidence.find((e) => e.sentence) ??
    evidence[0]
  );
}

/** The page's own [n] when the source is in its list, else the source by name and id (for read_source). */
function sourceRef(e: ConnectionEvidence, numbered: Map<string, number>): string {
  const n = numbered.get(e.source_id.toLowerCase());
  if (n) return `[${n}]${e.source_archived ? ' (archived source)' : ''}`;
  return `(source: ${e.source_title}, \`${e.source_id}\`${e.source_archived ? ', archived' : ''})`;
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
