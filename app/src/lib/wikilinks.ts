import type Database from 'better-sqlite3';
import { insertPageLink } from './db';

/**
 * Replace all wikilinks for a page in a single transaction:
 * delete existing 'wikilink' rows for this source page, then parse [[Title]]
 * tokens from the markdown and insert one row per resolvable, deduped target.
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

    const rawLinks = markdown.match(/\[\[([^\]]+)\]\]/g) ?? [];
    const seenTargets = new Set<string>();
    for (const link of rawLinks) {
      const title = link.slice(2, -2).trim();
      const toPageId = titleMap.get(title.toLowerCase());
      if (toPageId && toPageId !== pageId && !seenTargets.has(toPageId)) {
        seenTargets.add(toPageId);
        insertPageLink(pageId, toPageId, 'wikilink');
      }
    }
  })();
}
