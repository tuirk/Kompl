/**
 * The numbered source list of a wiki page, shared by the page view and the
 * page-data API (MCP read_page) so citation numbers always agree.
 *
 * Cited sources come first, numbered in order of first citation (the order
 * scanCitations / citationsToText return); the page's other provenance
 * sources follow. Provenance gains a row on every recompile, so rows are
 * collapsed to one per source.
 */

import { getDb } from './db';

export interface NumberedSource {
  /** 1-based number; matches the [n] / superscript markers in the text. */
  n: number;
  source_id: string;
  title: string | null;
  source_url: string | null;
  /** Latest compile of this page from the source (or ingest date if not provenance). */
  date: string | null;
  /** 'created' if the source created the page, otherwise 'updated'. Null if not provenance. */
  contribution_type: string | null;
  cited: boolean;
}

interface Row {
  source_id: string;
  title: string | null;
  source_url: string | null;
  date: string | null;
  contribution_type: string | null;
}

/** Lower-cased titles of every source. Lets the citation scanner recognise
 *  legacy groups such as "(uuid, Bitcoin Basics)" as pure citations. */
export function getSourceTitleSet(): Set<string> {
  const rows = getDb().prepare('SELECT title FROM sources').all() as Array<{ title: string | null }>;
  return new Set(rows.map((r) => (r.title ?? '').trim().toLowerCase()).filter(Boolean));
}

export function getNumberedSources(pageId: string, citedOrder: string[]): NumberedSource[] {
  const db = getDb();
  // MIN(contribution_type): 'created' sorts before 'updated'.
  const provRows = db
    .prepare(
      `SELECT p.source_id, s.title, s.source_url,
              MAX(p.date_compiled) AS date, MIN(p.contribution_type) AS contribution_type
         FROM provenance p
         JOIN sources s ON s.source_id = p.source_id
        WHERE p.page_id = ?
        GROUP BY p.source_id
        ORDER BY MAX(p.date_compiled) DESC`
    )
    .all(pageId) as Row[];

  const byId = new Map(provRows.map((r) => [r.source_id.toLowerCase(), r]));
  const missing = citedOrder.filter((id) => !byId.has(id));
  if (missing.length > 0) {
    // Cited but not (or no longer) provenance: look the source up directly.
    const rows = db
      .prepare(
        `SELECT source_id, title, source_url, date_ingested AS date, NULL AS contribution_type
           FROM sources
          WHERE lower(source_id) IN (${missing.map(() => '?').join(',')})`
      )
      .all(...missing) as Row[];
    for (const r of rows) byId.set(r.source_id.toLowerCase(), r);
  }

  const cited = new Set(citedOrder);
  const ordered: Array<Row & { cited: boolean }> = [
    ...citedOrder.map((id) => ({
      ...(byId.get(id) ?? { source_id: id, title: null, source_url: null, date: null, contribution_type: null }),
      cited: true,
    })),
    ...provRows.filter((r) => !cited.has(r.source_id.toLowerCase())).map((r) => ({ ...r, cited: false })),
  ];
  return ordered.map((r, i) => ({ n: i + 1, ...r }));
}
