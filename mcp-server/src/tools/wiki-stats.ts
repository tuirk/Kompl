import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KomplClient } from '../kompl-client.js';
import { failure, READ_ONLY, text } from '../result.js';
import type { WikiIndex, WikiStats } from '../types.js';

// GET /api/wiki/stats + /api/wiki/index. Deliberately not /api/health: that
// route repairs stuck compile sessions as a side effect, and a stats lookup
// must not write anything.
export function registerWikiStats(server: McpServer, client: KomplClient): void {
  server.registerTool(
    'wiki_stats',
    {
      title: 'Wiki stats',
      description:
        'Get statistics about the Kompl knowledge wiki — source and page counts, categories, last ingest and compile times.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const [stats, index] = await Promise.all([
        client.get<WikiStats>('/api/wiki/stats'),
        client.get<WikiIndex>('/api/wiki/index'),
      ]);
      if (!stats.ok) return failure(`Stats unavailable: ${stats.message}`);
      const s = stats.data;
      const categoryCount = index.ok ? Object.keys(index.data.categories).length : 'unknown';
      return text(
        [
          `**Kompl Wiki Stats**`,
          `• Sources: ${s.source_count} active`,
          `• Pages: ${s.page_count} (${s.entity_count} entities, ${s.concept_count} concepts)`,
          `• Categories: ${categoryCount}`,
          `• Last source added: ${s.last_ingested ?? 'never'}`,
          `• Last compile: ${s.last_compiled ?? 'never'}`,
        ].join('\n')
      );
    }
  );
}
