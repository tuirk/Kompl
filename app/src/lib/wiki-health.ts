/**
 * Wiki health checks that are plain database reads: no LLM, no writes.
 *
 * The manual health check (POST /api/wiki/lint-pass) runs these plus an LLM
 * contradiction scan and records the result; GET /api/wiki/status (MCP
 * wiki_status) runs them live so an agent can report gaps without spending
 * anything.
 */

import type Database from 'better-sqlite3';
import { getAllArchivedPageIds } from './db';
import { SAVED_LINKS_PAGE_ID, type LintDeadProvenance, type LintMissingCrossRef, type LintOrphanPage, type LintStalePage } from './lint-result';
import { findMissingPages, MISSING_PAGE_MIN_SOURCES } from './missing-pages';
import { SYNTHESIZED_PAGE_TYPES } from './page-sections';

export interface HealthChecks {
  orphan_pages: LintOrphanPage[];
  stale_pages: LintStalePage[];
  missing_cross_refs: LintMissingCrossRef[];
  dead_provenance: LintDeadProvenance[];
}

export interface ThinPage {
  page_id: string;
  title: string;
  page_type: string;
  /** Pages linking here: a thin page many pages rely on matters most. */
  backlinks: number;
}

/** missing_cross_refs lists at most this many names. */
export const MISSING_NAMES_LIMIT = 50;
/** Sources a name needs for missing_cross_refs: the same threshold as the graph. */
export const MISSING_NAMES_MIN_SOURCES = MISSING_PAGE_MIN_SOURCES;
/** How long wiki_status reuses a result while the tables keep their size. */
const CACHE_MS = 60_000;
const cache = new WeakMap<Database.Database, { key: string; at: number; checks: HealthChecks }>();

/**
 * runHealthChecks for frequent readers (wiki_status): the names check reads
 * every mention and relation, so a result is reused for a minute unless a
 * row was added to or removed from the tables the checks read, or a source
 * was archived.
 */
export function runHealthChecksCached(db: Database.Database): HealthChecks {
  const { key } = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM entity_mentions) || ':' || (SELECT COUNT(*) FROM relationship_mentions) || ':' ||
              (SELECT COUNT(*) FROM pages) || ':' || (SELECT COUNT(*) FROM pages WHERE page_type = 'archived') || ':' ||
              (SELECT COUNT(*) FROM aliases) || ':' ||
              (SELECT COUNT(*) FROM aliases WHERE COALESCE(status, 'active') = 'active') || ':' ||
              (SELECT COUNT(*) FROM page_links) || ':' ||
              (SELECT COUNT(*) FROM provenance) || ':' || (SELECT COUNT(*) FROM sources) || ':' ||
              (SELECT COUNT(*) FROM sources WHERE status = 'archived') AS key`
    )
    .get() as { key: string };
  const hit = cache.get(db);
  if (hit && hit.key === key && Date.now() - hit.at < CACHE_MS) return hit.checks;
  const checks = runHealthChecks(db);
  cache.set(db, { key, at: Date.now(), checks });
  return checks;
}

export function runHealthChecks(db: Database.Database): HealthChecks {
  // Saved Links is Kompl's own list, linked from nowhere by design; archived
  // pages are put away. Neither is an orphan to fix.
  const archived = getAllArchivedPageIds();
  const orphan_pages = (db
    .prepare(
      `SELECT p.page_id, p.title
         FROM pages p
        WHERE p.page_id NOT IN (SELECT target_page_id FROM page_links)
          AND p.page_id NOT IN (SELECT source_page_id FROM page_links)
          AND p.page_id != ?
          AND p.page_type != 'archived'
        ORDER BY p.title COLLATE NOCASE`,
    )
    .all(SAVED_LINKS_PAGE_ID) as LintOrphanPage[]).filter((p) => !archived.has(p.page_id));

  const stale_pages = db
    .prepare(
      `SELECT page_id, title, last_updated
         FROM pages
        WHERE page_type = 'source-summary'
          AND source_count = 1
          AND datetime(last_updated) < datetime('now', '-30 days')
        ORDER BY last_updated ASC`,
    )
    .all() as LintStalePage[];

  // Names the sources keep naming that no page covers yet, as the graph's
  // "Show missing pages" defines them (missing-pages.ts), from 3 sources.
  const missing_cross_refs = findMissingPages(db, { minSources: MISSING_NAMES_MIN_SOURCES, limit: MISSING_NAMES_LIMIT }).map(
    (m): LintMissingCrossRef => ({ entity_text: m.name, mention_count: m.source_count })
  );

  const dead_provenance = db
    .prepare(
      `SELECT pr.id AS provenance_id,
              pr.source_id,
              pr.page_id,
              COALESCE(pg.title, pr.page_id) AS page_title
         FROM provenance pr
         LEFT JOIN pages pg ON pg.page_id = pr.page_id
        WHERE pr.source_id NOT IN (SELECT source_id FROM sources)
        ORDER BY page_title COLLATE NOCASE, pr.source_id`,
    )
    .all() as LintDeadProvenance[];

  return { orphan_pages, stale_pages, missing_cross_refs, dead_provenance };
}

/**
 * Synthesized pages (entity, concept, comparison, overview) that rest on a
 * single source, most linked first. Source pages have one source by nature
 * and archived pages don't show, so both are left out.
 */
export function getThinPages(db: Database.Database): ThinPage[] {
  const types = [...SYNTHESIZED_PAGE_TYPES];
  const archived = getAllArchivedPageIds();
  const rows = db
    .prepare(
      `SELECT p.page_id, p.title, p.page_type,
              (SELECT COUNT(DISTINCT l.source_page_id) FROM page_links l
                WHERE l.target_page_id = p.page_id AND l.source_page_id != p.page_id) AS backlinks
         FROM pages p
        WHERE p.page_type IN (${types.map(() => '?').join(', ')})
          AND (SELECT COUNT(DISTINCT pr.source_id) FROM provenance pr WHERE pr.page_id = p.page_id) = 1
        ORDER BY backlinks DESC, p.title COLLATE NOCASE`,
    )
    .all(...types) as ThinPage[];
  return rows.filter((r) => !archived.has(r.page_id));
}
