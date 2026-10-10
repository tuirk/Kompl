import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KomplClient } from '../kompl-client.js';
import { failure, READ_ONLY, text } from '../result.js';
import type { PageMeta, WikiIndex } from '../types.js';

/** The app's hybrid search caps a request at 100 results. */
const MAX_RESULTS = 100;
/** System page listing failed imports; not wiki content. */
const SAVED_LINKS_PAGE_ID = 'saved-links';

export function registerSearchWiki(server: McpServer, client: KomplClient): void {
  server.registerTool(
    'search_wiki',
    {
      title: 'Search wiki',
      description:
        "Find pages in the user's Kompl wiki. With a query (a question, topic or name) it searches by keywords " +
        'and meaning, best match first. Without a query it lists pages, newest first; filter by category or ' +
        'page_type to browse. Returns titles, types, summaries and the page_ids read_page needs.',
      inputSchema: {
        query: z
          .string()
          .optional()
          .describe('What to look for: a question, topic or name. Leave out to browse pages.'),
        category: z.string().optional().describe('Only pages in this category (optional)'),
        page_type: z
          .string()
          .optional()
          .describe(
            'Only pages of this type: entity, concept, comparison, overview, source-summary, original-source (optional)'
          ),
        limit: z.number().int().min(1).max(50).default(10).describe('Max results (default 10)'),
        offset: z.number().int().min(0).default(0).describe('Skip this many results, to page through (default 0)'),
      },
      annotations: READ_ONLY,
    },
    async ({ query, category, page_type, limit, offset }) => {
      const q = query?.trim();
      return q
        ? search(client, q, { category, page_type, limit, offset })
        : browse(client, { category, page_type, limit, offset });
    }
  );
}

interface Filters {
  category?: string;
  page_type?: string;
  limit: number;
  offset: number;
}

// GET /api/pages/search?mode=hybrid → { items, count, degraded }
async function search(client: KomplClient, query: string, f: Filters) {
  if (f.offset >= MAX_RESULTS) return failure(`Search returns at most ${MAX_RESULTS} results; use a narrower query.`);
  const wanted = Math.min(f.offset + f.limit, MAX_RESULTS);
  const res = await client.get<{ items: PageMeta[]; count: number; degraded?: boolean }>('/api/pages/search', {
    q: query,
    mode: 'hybrid',
    limit: wanted,
    category: f.category,
    page_type: f.page_type,
  });
  if (!res.ok) return failure(`Search failed: ${res.message}`);

  let found = res.data.items;
  const notes: string[] = [];
  if (res.data.degraded === undefined) {
    // An app from before hybrid search ignores mode, category and page_type:
    // apply what can be applied here and say why results are keyword-only.
    found = found.filter((p) => p.page_id !== SAVED_LINKS_PAGE_ID && matchesFilters(p, f));
    notes.push('(This Kompl app is older than its MCP server, so results are keyword matches only. Run `kompl update`.)');
  } else if (res.data.degraded) {
    notes.push('(Meaning-based search is unavailable right now; these are keyword matches only.)');
  }
  const items = found.slice(f.offset);
  if (!items.length) {
    return text([...notes, f.offset > 0 && found.length ? `No more results: ${found.length} matched.` : 'No results found.'].join('\n'));
  }

  const lines = items.map(
    (p) =>
      `**${p.title}** (${p.page_type})${p.category ? ` [${p.category}]` : ''} — ${p.summary ?? 'No summary'}\n  ID: \`${p.page_id}\``
  );
  if (res.data.count === wanted && wanted < MAX_RESULTS) {
    notes.push(`More may match: call again with offset=${f.offset + items.length}.`);
  }
  return text([`${items.length} result(s):`, '', lines.join('\n\n'), ...(notes.length ? ['', ...notes] : [])].join('\n'));
}

// GET /api/wiki/index → every non-archived page, newest first; filtered here.
async function browse(client: KomplClient, f: Filters) {
  const res = await client.get<WikiIndex>('/api/wiki/index');
  if (!res.ok) return failure(`Listing pages failed: ${res.message}`);

  const pages = res.data.pages.filter((p) => p.page_id !== SAVED_LINKS_PAGE_ID && matchesFilters(p, f));
  if (!pages.length) return text('No pages match the given filters.');

  const shown = pages.slice(f.offset, f.offset + f.limit);
  if (!shown.length) return text(`No more pages: there are ${pages.length}.`);
  const lines = shown.map(
    (p) =>
      `• **${p.title}** (${p.page_type}) [${p.category ?? 'Uncategorized'}] — ${p.source_count} source(s)\n  ID: \`${p.page_id}\``
  );
  const end = f.offset + shown.length;
  const header = `Pages ${f.offset + 1}–${end} of ${pages.length}, newest first:`;
  const next = end < pages.length ? ['', `More: call again with offset=${end}.`] : [];
  return text([header, '', lines.join('\n\n'), ...next].join('\n'));
}

function matchesFilters(page: PageMeta, f: Filters): boolean {
  return (
    (!f.category || page.category?.toLowerCase() === f.category.toLowerCase()) &&
    (!f.page_type || page.page_type === f.page_type)
  );
}
