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
  setPendingContent,
  clearPendingContent,
  type SavedLinkRow,
} from './db';

const PAGE_ID = 'saved-links';
const PAGE_TITLE = 'Saved Links';
const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

interface PeekedMetadata {
  title?: string | null;
  description?: string | null;
  og_image?: string | null;
}

function parseMetadata(raw: string | null): PeekedMetadata {
  if (!raw) return {};
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object') return parsed as PeekedMetadata;
  } catch {
    /* ignore malformed JSON — treat as empty */
  }
  return {};
}

function truncate(s: string, max: number): string {
  const trimmed = s.trim().replace(/\s+/g, ' ');
  return trimmed.length <= max ? trimmed : `${trimmed.slice(0, max - 1)}…`;
}

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
    const meta = parseMetadata(link.metadata);
    const titleSource = link.title ?? meta.title ?? link.source_url;
    const title = titleSource.replace(/[[\]]/g, '');
    const dateStr = link.date_saved ?? link.date_attempted.slice(0, 10);
    // Trim verbose error prefixes so the page stays readable
    const reason = link.error
      .replace(/^convert_url_failed:\s*\d+\s*/i, '')
      .replace(/^ingest_failed:\s*/i, '')
      .slice(0, 80);
    lines.push(`- [${title}](${link.source_url}) — ${dateStr} · *${reason}*`);
    if (meta.description) {
      lines.push(`  > ${truncate(meta.description, 160)}`);
    }
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

  // Deterministic path — known before the file is written.
  const expectedPath = `/data/pages/${PAGE_ID}.md.gz`;

  const db = getDb();
  const existing = getPage(PAGE_ID);

  // Phase 2 (sync transaction): DB upsert + FTS + outbox.
  // File is NOT written yet — pending_content stores markdown for Phase 3a flush.
  db.transaction(() => {
    const summary =
      links.length === 0
        ? 'All saved links have been imported.'
        : `${links.length} link${links.length === 1 ? '' : 's'} saved but not yet imported.`;

    if (existing) {
      updatePageContent(PAGE_ID, expectedPath, null, 0);
      db.prepare(`UPDATE pages SET summary = ? WHERE page_id = ?`).run(summary, PAGE_ID);
    } else {
      insertPage({
        page_id: PAGE_ID,
        title: PAGE_TITLE,
        page_type: 'overview',
        category: null,
        summary,
        content_path: expectedPath,
        previous_content_path: null,
      });
    }

    // Outbox: store markdown for Phase 3a flush + crash recovery.
    setPendingContent(PAGE_ID, markdown);

    // FTS upsert so the page is searchable in the wiki
    db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(PAGE_ID);
    db.prepare('INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)').run(
      PAGE_ID,
      PAGE_TITLE,
      markdown
    );
  })();

  // Phase 3a (awaited): flush pending_content to disk via nlp-service.
  // Errors are swallowed — callers are fire-and-forget; boot reconciler handles orphans.
  try {
    const writeResult = await callWritePage(markdown);
    clearPendingContent(PAGE_ID, writeResult.previous_path);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'file_flush_failed', context: 'saved_links_regenerate', page_id: PAGE_ID, error: msg }));
  }
}
