/**
 * regenerateSavedLinksPage — builds and writes the "Saved Links" wiki page.
 *
 * Called fire-and-forget after every insertIngestFailure or resolveIngestFailures
 * so the page always reflects the current set of unresolved links.
 *
 * The page (page_id: 'saved-links') lists every bookmark/URL the user saved that
 * could not be automatically imported. Once a link is successfully ingested it
 * drops off. If all links are imported the page shows a cleared state.
 */

import {
  getDb,
  getPage,
  getUnresolvedLinks,
  insertPage,
  updatePageContent,
  type SavedLinkRow,
} from './db';

const PAGE_ID = 'saved-links';
const PAGE_TITLE = 'Saved Links';
const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

function buildMarkdown(links: SavedLinkRow[]): string {
  if (links.length === 0) {
    return [
      `# ${PAGE_TITLE}`,
      '',
      'All saved links have been imported into your wiki.',
      '',
    ].join('\n');
  }

  const lines: string[] = [
    `# ${PAGE_TITLE}`,
    '',
    `${links.length} link${links.length === 1 ? '' : 's'} saved but not yet imported.`,
    '',
  ];

  for (const link of links) {
    const title = (link.title ?? link.source_url).replace(/[[\]]/g, '');
    const dateStr = link.date_saved ?? link.date_attempted.slice(0, 10);
    // Trim verbose error prefixes so the page stays readable
    const reason = link.error
      .replace(/^convert_url_failed:\s*\d+\s*/i, '')
      .replace(/^ingest_failed:\s*/i, '')
      .slice(0, 80);
    lines.push(`- [${title}](${link.source_url}) — ${dateStr} · *${reason}*`);
  }

  lines.push('');
  return lines.join('\n');
}

async function callWritePage(
  markdown: string
): Promise<{ current_path: string; previous_path: string | null }> {
  const res = await fetch(`${NLP_SERVICE_URL}/storage/write-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page_id: PAGE_ID, markdown }),
    signal: AbortSignal.timeout(15_000),
  });
  if (!res.ok) throw new Error(`write_page_failed: ${res.status}`);
  return res.json() as Promise<{ current_path: string; previous_path: string | null }>;
}

export async function regenerateSavedLinksPage(): Promise<void> {
  const links = getUnresolvedLinks();
  const markdown = buildMarkdown(links);

  const writeResult = await callWritePage(markdown);

  const db = getDb();
  const existing = getPage(PAGE_ID);

  db.transaction(() => {
    const summary =
      links.length === 0
        ? 'All saved links have been imported.'
        : `${links.length} link${links.length === 1 ? '' : 's'} saved but not yet imported.`;

    if (existing) {
      updatePageContent(PAGE_ID, writeResult.current_path, writeResult.previous_path, 0);
      // Update summary in pages row too
      db.prepare(`UPDATE pages SET summary = ? WHERE page_id = ?`).run(summary, PAGE_ID);
    } else {
      insertPage({
        page_id: PAGE_ID,
        title: PAGE_TITLE,
        page_type: 'overview',
        category: null,
        summary,
        content_path: writeResult.current_path,
        previous_content_path: writeResult.previous_path,
      });
    }

    // FTS upsert so the page is searchable in the wiki
    db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(PAGE_ID);
    db.prepare('INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)').run(
      PAGE_ID,
      PAGE_TITLE,
      markdown
    );
  })();
}
