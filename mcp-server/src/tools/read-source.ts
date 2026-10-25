import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KomplClient } from '../kompl-client.js';
import { pageIdInput, sourceIdInput } from '../ids.js';
import { failure, READ_ONLY, text } from '../result.js';
import type { PageData, SourceContent } from '../types.js';

// GET /api/sources/{source_id}/content; a page citation [n] is resolved
// through /api/wiki/{page_id}/data first.
export function registerReadSource(server: McpServer, client: KomplClient): void {
  server.registerTool(
    'read_source',
    {
      title: 'Read source',
      description:
        'Read the original text of a source Kompl compiled from, to check what a citation actually says. ' +
        'Identify it by the source_id shown in every source list, or by page_id and n for citation [n] in ' +
        "read_page's text (research_topic numbers its sources across pages, so use its source_id). With a query " +
        '(e.g. the claim to check) it returns the best-matching passages; otherwise the text from offset, about ' +
        '8,000 characters at a time.',
      inputSchema: {
        source_id: sourceIdInput()
          .optional()
          .describe('Source id from a source list (read_page, research_topic, list_sources), or use page_id and n'),
        page_id: pageIdInput().optional().describe('With n: the page whose citation to follow'),
        n: z
          .number()
          .int()
          .min(1)
          .optional()
          .describe("With page_id: the citation number [n] in read_page's text (not research_topic's numbers)"),
        query: z.string().optional().describe('Return the passages that best match this instead of the text'),
        offset: z
          .number()
          .int()
          .min(0)
          .default(0)
          .describe('Where to continue reading, from the previous answer (ignored with a query)'),
      },
      annotations: READ_ONLY,
    },
    async ({ source_id, page_id, n, query, offset }) => {
      let id = source_id;
      let citedBy = '';
      if (!id) {
        if (!page_id || n === undefined) return failure('Give a source_id, or a page_id with the citation number n.');
        const page = await client.get<PageData>(`/api/wiki/${encodeURIComponent(page_id)}/data`);
        if (!page.ok) {
          return page.status === 404
            ? failure(`Page not found: ${page_id}. Use search_wiki to find page ids.`)
            : failure(`Failed to load page ${page_id}: ${page.message}`);
        }
        const cited = page.data.sources.find((s) => s.n === n);
        if (!cited) {
          const count = page.data.sources.length;
          return failure(
            count
              ? `"${page.data.title}" has no source [${n}]; its sources are numbered 1–${count}.`
              : `"${page.data.title}" has no sources.`
          );
        }
        id = cited.source_id;
        citedBy = `Source [${n}] of "${page.data.title}"`;
      }

      const q = query?.trim();
      const res = await client.get<SourceContent>(`/api/sources/${encodeURIComponent(id)}/content`, {
        q,
        offset: q ? undefined : offset,
      });
      if (!res.ok) return failure(sourceError(id, res.status, res.message));
      return text(format(res.data, citedBy));
    }
  );
}

function sourceError(id: string, status: number | null, message: string): string {
  if (status === 404 && message === 'HTTP 404') {
    return "This Kompl app can't serve source text yet. Run `kompl update`.";
  }
  return status === 404 ? `${message} Use list_sources to find source ids.` : `Failed to read source ${id}: ${message}`;
}

function format(src: SourceContent, citedBy: string): string {
  const facts = [src.source_type, `added ${src.date_ingested.slice(0, 10)}`];
  if (src.status !== 'active') facts.push(src.status);
  if (src.source_url) facts.push(src.source_url);
  const head = [`# ${src.title}`, facts.join(' · '), ...(citedBy ? [citedBy] : []), ''];

  if (src.mode === 'passages') {
    const passages = src.passages ?? [];
    if (!passages.length) {
      return [...head, `No passage of this ${src.total_chars}-character source matches "${src.query}". Read the text without a query instead.`].join('\n');
    }
    const body = passages.map(
      (p) => `--- ${p.heading ? `${p.heading} ` : ''}(at character ${p.start})\n${p.text}`
    );
    return [...head, `Passages matching "${src.query}" (of ${src.total_chars} characters):`, '', body.join('\n\n')].join('\n');
  }

  const start = src.offset ?? 0;
  const chunk = src.text ?? '';
  if (!chunk && start > 0) {
    return [...head, `No text past character ${start}: the source has ${src.total_chars} characters.`].join('\n');
  }
  const range = `Characters ${start + 1}–${start + chunk.length} of ${src.total_chars}:`;
  const next = src.next_offset != null ? ['', `More: call again with offset=${src.next_offset}.`] : [];
  return [...head, range, '', chunk || '(empty)', ...next].join('\n');
}
