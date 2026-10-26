/**
 * Backup rows that name a source or page the backup lacks (POST /api/import).
 *
 * Backups made before every source and page went in (until October 2026 a
 * backup held only the 200 newest sources, and no page whose sources were
 * all archived) still hold provenance, mentions, extractions, links and
 * aliases for the ones left out. The import restores everything else,
 * skips those rows instead of failing on them, and reports what it left
 * out. Lookups read the database, inside the import's transaction, once
 * the sources and pages are in.
 */

import type Database from 'better-sqlite3';

export interface SkippedRows {
  /** Rows left out, all tables together. */
  total: number;
  /** Rows left out per table. */
  tables: Record<string, number>;
  /** Distinct sources and pages the left-out rows named. */
  missing_count: number;
  /** The first few of them, e.g. "source src-1a2b3c". */
  missing: string[];
}

const EXAMPLES = 5;

export function referenceCheck(db: Database.Database) {
  const sourceExists = db.prepare('SELECT 1 FROM sources WHERE source_id = ?');
  const pageExists = db.prepare('SELECT 1 FROM pages WHERE page_id = ?');
  const tables: Record<string, number> = {};
  const missing = new Set<string>();
  const count = (table: string, n: number) => {
    tables[table] = (tables[table] ?? 0) + n;
  };
  const absent = (kind: 'source' | 'page', ids: unknown[] = []) =>
    ids
      .filter((id) => id !== null && id !== undefined)
      .filter((id) => typeof id !== 'string' || !(kind === 'source' ? sourceExists : pageExists).get(id))
      .map((id) => `${kind} ${String(id)}`);

  return {
    /** True when every source and page the row names exists; otherwise the row is counted as left out. */
    keep(table: string, refs: { sources?: unknown[]; pages?: unknown[] }): boolean {
      const gone = [...absent('source', refs.sources), ...absent('page', refs.pages)];
      if (gone.length === 0) return true;
      count(table, 1);
      for (const name of gone) missing.add(name);
      return false;
    },
    /** Rows a table's own import left out (it checks its references itself). */
    leftOut(table: string, n: number): void {
      if (n > 0) count(table, n);
    },
    summary(): SkippedRows {
      return {
        total: Object.values(tables).reduce((sum, n) => sum + n, 0),
        tables,
        missing_count: missing.size,
        missing: [...missing].slice(0, EXAMPLES),
      };
    },
  };
}
