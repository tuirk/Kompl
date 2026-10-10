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
import type { LintDeadProvenance, LintMissingCrossRef, LintOrphanPage, LintStalePage } from './lint-result';
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

/**
 * Entity labels that name amounts, dates and positions ("2009", "second",
 * "40%") rather than things a page could be about.
 */
const NON_TOPIC_LABELS = ['DATE', 'TIME', 'PERCENT', 'MONEY', 'QUANTITY', 'ORDINAL', 'CARDINAL'];

/** missing_cross_refs lists at most this many names. */
export const MISSING_NAMES_LIMIT = 50;
/** How long wiki_status reuses a result while the tables keep their size. */
const CACHE_MS = 60_000;
const cache = new WeakMap<Database.Database, { key: string; at: number; checks: HealthChecks }>();

/**
 * runHealthChecks for frequent readers (wiki_status): the names check reads
 * every extraction, so a result is reused for a minute unless a row was
 * added to or removed from the tables the checks read.
 */
export function runHealthChecksCached(db: Database.Database): HealthChecks {
  const { key } = db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM extractions) || ':' || (SELECT COUNT(*) FROM pages) || ':' ||
              (SELECT COUNT(*) FROM aliases) || ':' || (SELECT COUNT(*) FROM page_links) || ':' ||
              (SELECT COUNT(*) FROM provenance) || ':' || (SELECT COUNT(*) FROM sources) AS key`
    )
    .get() as { key: string };
  const hit = cache.get(db);
  if (hit && hit.key === key && Date.now() - hit.at < CACHE_MS) return hit.checks;
  const checks = runHealthChecks(db);
  cache.set(db, { key, at: Date.now(), checks });
  return checks;
}

export function runHealthChecks(db: Database.Database): HealthChecks {
  const orphan_pages = db
    .prepare(
      `SELECT p.page_id, p.title
         FROM pages p
        WHERE p.page_id NOT IN (SELECT target_page_id FROM page_links)
          AND p.page_id NOT IN (SELECT source_page_id FROM page_links)
        ORDER BY p.title COLLATE NOCASE`,
    )
    .all() as LintOrphanPage[];

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

  // Names mentioned in 3+ sources that no page covers yet. A name counts as
  // covered by any page title or page alias, whatever the case: "bitcoin"
  // is covered by a "Bitcoin" concept page, not only by an entity page.
  const missing_cross_refs = db
    .prepare(
      `SELECT json_extract(value, '$.text') AS entity_text,
              COUNT(DISTINCT e.source_id) AS mention_count
         FROM extractions e, json_each(json_extract(e.ner_output, '$.entities'))
        WHERE COALESCE(json_extract(value, '$.label'), '') NOT IN (${NON_TOPIC_LABELS.map(() => '?').join(', ')})
          AND lower(json_extract(value, '$.text')) NOT IN (
                SELECT lower(title) FROM pages WHERE page_type != 'archived'
              )
          AND lower(json_extract(value, '$.text')) NOT IN (
                SELECT lower(alias) FROM aliases WHERE canonical_page_id IS NOT NULL
              )
        GROUP BY lower(json_extract(value, '$.text'))
       HAVING COUNT(DISTINCT e.source_id) >= 3
        ORDER BY mention_count DESC, entity_text COLLATE NOCASE
        LIMIT ?`,
    )
    .all(...NON_TOPIC_LABELS, MISSING_NAMES_LIMIT) as LintMissingCrossRef[];

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
