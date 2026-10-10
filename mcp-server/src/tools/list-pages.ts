import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KomplClient } from '../kompl-client.js';
import { failure, READ_ONLY, text } from '../result.js';
import type { WikiIndex } from '../types.js';

// GET /api/wiki/index → { pages, categories, total_pages }; filtered here so
// the app route stays a plain catalog.
export function registerListPages(server: McpServer, client: KomplClient): void {
  server.registerTool(
    'list_pages',
    {
      title: 'List pages',
      description: 'List all pages in the Kompl wiki. Optionally filter by category or page type.',
      inputSchema: {
        category: z.string().optional().describe('Filter by category name (optional)'),
        page_type: z
          .string()
          .optional()
          .describe('Filter by type: entity, concept, comparison, overview, source-summary (optional)'),
      },
      annotations: READ_ONLY,
    },
    async ({ category, page_type }) => {
      const res = await client.get<WikiIndex>('/api/wiki/index');
      if (!res.ok) return failure(`Listing pages failed: ${res.message}`);
      let pages = res.data.pages;
      if (category) pages = pages.filter((p) => p.category?.toLowerCase() === category.toLowerCase());
      if (page_type) pages = pages.filter((p) => p.page_type === page_type);
      if (!pages.length) return text('No pages match the given filters.');
      const formatted = pages
        .map(
          (p) =>
            `• **${p.title}** (${p.page_type}) [${p.category ?? 'Uncategorized'}] — ${p.source_count} source(s)\n  ID: \`${p.page_id}\``
        )
        .join('\n\n');
      return text(`${pages.length} page(s):\n\n${formatted}`);
    }
  );
}
