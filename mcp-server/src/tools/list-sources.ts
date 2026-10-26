import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KomplClient } from '../kompl-client.js';
import { fence } from '../fence.js';
import { failure, READ_ONLY, text } from '../result.js';
import type { SourceList, SourceListItem } from '../types.js';

// GET /api/sources?search=&status=&limit=&offset= → { sources, total, returned }, newest first
export function registerListSources(server: McpServer, client: KomplClient): void {
  server.registerTool(
    'list_sources',
    {
      title: 'List sources',
      description:
        'List the sources (articles, files, notes) the user added to Kompl, newest first, with how many wiki ' +
        'pages each one feeds. Search by title or address, e.g. to check whether a link was already saved.',
      inputSchema: {
        query: z.string().optional().describe('Text in the title or address (optional)'),
        status: z.enum(['active', 'archived']).optional().describe('Only active or only archived sources (optional)'),
        limit: z.number().int().min(1).max(100).default(20).describe('Max results (default 20)'),
        offset: z.number().int().min(0).default(0).describe('Skip this many results, to page through (default 0)'),
      },
      annotations: READ_ONLY,
    },
    async ({ query, status, limit, offset }) => {
      const q = query?.trim();
      const res = await client.get<SourceList>('/api/sources', { search: q, status, limit, offset });
      if (!res.ok) return failure(`Listing sources failed: ${res.message}`);
      const { sources, total } = res.data;
      if (!sources.length) {
        return text(offset > 0 && total ? `No more sources: there are ${total}.` : 'No sources match.');
      }
      const end = offset + sources.length;
      const header = `Sources ${offset + 1}–${end} of ${total}${q ? ` matching "${q}"` : ''}, newest first:`;
      const next = end < total ? ['', `More: call again with offset=${end}.`] : [];
      // Titles are wiki text (fence.ts); the header and next step are Kompl's.
      return text([header, '', fence(sources.map(sourceLine).join('\n\n')), ...next].join('\n'));
    }
  );
}

function sourceLine(s: SourceListItem): string {
  const facts = [s.source_type, `added ${s.date_ingested.slice(0, 10)}`];
  if (s.status !== 'active') facts.push(s.status);
  facts.push(s.page_count ? `in ${s.page_count} page(s)` : 'in no pages yet');
  return [`• **${s.title}** (${facts.join(', ')})`, ...(s.source_url ? [`  ${s.source_url}`] : []), `  ID: \`${s.source_id}\``].join(
    '\n'
  );
}
