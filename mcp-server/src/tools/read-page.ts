import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KomplClient } from '../kompl-client.js';
import { failure, READ_ONLY, text } from '../result.js';
import type { PageData } from '../types.js';

// GET /api/wiki/{page_id}/data → page metadata, markdown body, numbered sources
export function registerReadPage(server: McpServer, client: KomplClient): void {
  server.registerTool(
    'read_page',
    {
      title: 'Read page',
      description:
        'Read the full content of a Kompl wiki page by its page_id. Use search_wiki first to find page_ids.',
      inputSchema: {
        page_id: z.string().describe('The page_id from search results'),
      },
      annotations: READ_ONLY,
    },
    async ({ page_id }) => {
      const res = await client.get<PageData>(`/api/wiki/${encodeURIComponent(page_id)}/data`);
      if (!res.ok) {
        return res.status === 404
          ? failure(`Page not found: ${page_id}. Use search_wiki to find page ids.`)
          : failure(`Failed to load page ${page_id}: ${res.message}`);
      }
      const page = res.data;
      // Newer apps number the sources to match the [n] citation markers in
      // the content; older ones send an unnumbered list.
      const sourceList = page.sources.length
        ? page.sources
            .map((s) => (s.n ? `  [${s.n}] ${s.title}` : `  - ${s.title} (${s.contribution_type})`))
            .join('\n')
        : '  (none)';
      return text(
        [
          `# ${page.title}`,
          `Type: ${page.page_type}${page.category ? ` | Category: ${page.category}` : ''} | Sources: ${page.source_count}`,
          `Last updated: ${page.last_updated}`,
          ``,
          page.content || '(no content)',
          ``,
          `---`,
          `**Sources** (the [n] markers above refer to these):`,
          sourceList,
        ].join('\n')
      );
    }
  );
}
