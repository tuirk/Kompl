import type Database from 'better-sqlite3';
import { getPageTitleMap, insertPageLink, readPageMarkdown } from './db';
import { findWikilinks } from './wikilink-syntax';

/**
 * Replace all wikilinks for a page in a single transaction:
 * delete existing 'wikilink' rows for this source page, then parse [[Title]]
 * and [[Title|label]] tokens from the markdown and insert one row per
 * resolvable, deduped target.
 *
 * Self-links and unknown titles are silently skipped. Other link_types
 * (provenance, entity-ref) are untouched.
 *
 * Must run inside the same process that owns the SQLite write handle.
 * better-sqlite3 transactions are sync — no `await` inside the callback.
 *
 * Used by both /api/compile/commit (session compile, Phase 3c) and
 * lib/recompile.ts (per-source recompile, Phase 3c). Without the DELETE
 * step, removed [[wikilinks]] left phantom backlinks on the target page
 * forever — see CLAUDE.md "stale wikilinks" entry.
 */
export function syncPageWikilinks(
  db: Database.Database,
  pageId: string,
  markdown: string,
  titleMap: Map<string, string>
): void {
  db.transaction(() => {
    db.prepare(
      `DELETE FROM page_links WHERE source_page_id = ? AND link_type = 'wikilink'`
    ).run(pageId);

    const seenTargets = new Set<string>();
    for (const link of findWikilinks(markdown)) {
      const toPageId = titleMap.get(link.target.toLowerCase());
      if (toPageId && toPageId !== pageId && !seenTargets.has(toPageId)) {
        seenTargets.add(toPageId);
        insertPageLink(pageId, toPageId, 'wikilink');
      }
    }
  })();
}

/**
 * Re-derive the 'wikilink' rows of every page from its current markdown.
 * Used once at boot after a parser fix (instrumentation.ts) and after a
 * backup import, so links that an older parser missed (e.g. piped
 * [[Target|label]] links) show up in backlinks and the graph. Page text is
 * never modified. Idempotent.
 */
export function resyncAllWikilinks(db: Database.Database): { synced: number; skipped: number } {
  const titleMap = getPageTitleMap();
  const pageIds = db.prepare('SELECT page_id FROM pages').all() as Array<{ page_id: string }>;
  let synced = 0;
  let skipped = 0;
  for (const { page_id } of pageIds) {
    const markdown = readPageMarkdown(page_id);
    if (markdown === null) {
      skipped++;
      continue;
    }
    syncPageWikilinks(db, page_id, markdown, titleMap);
    synced++;
  }
  return { synced, skipped };
}
