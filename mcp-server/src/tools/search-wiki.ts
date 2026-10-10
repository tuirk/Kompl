import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KomplClient } from '../kompl-client.js';
import { failure, READ_ONLY, text } from '../result.js';
import type { PageMeta } from '../types.js';

// GET /api/pages/search?q=&limit= → { items: PageMeta[], count }
export function registerSearchWiki(server: McpServer, client: KomplClient): void {
  server.registerTool(
    'search_wiki',
    {
      title: 'Search wiki',
      description:
        'Search the Kompl knowledge wiki for pages matching a query. Returns page titles, types, and summaries.',
      inputSchema: {
        query: z.string().describe('Search query — topic, entity name, or keyword'),
        limit: z.number().int().min(1).max(100).default(10).describe('Max results (default 10)'),
      },
      annotations: READ_ONLY,
    },
    async ({ query, limit }) => {
      const res = await client.get<{ items: PageMeta[]; count: number }>('/api/pages/search', {
        q: query,
        limit,
      });
      if (!res.ok) return failure(`Search failed: ${res.message}`);
      if (!res.data.items.length) return text('No results found.');
      const formatted = res.data.items
        .map(
          (p) =>
            `**${p.title}** (${p.page_type})${p.category ? ` [${p.category}]` : ''} — ${p.summary ?? 'No summary'}\n  ID: \`${p.page_id}\``
        )
        .join('\n\n');
      return text(`${res.data.count} result(s):\n\n${formatted}`);
    }
  );
}
