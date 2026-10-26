/**
 * A step of the wiki repair (after the sense fixes): source titles on one line. No AI call.
 *
 * A web page's <title> can carry the page's own indentation ("\n\t\tOn
 * automatically generating contrasting text colors with CSS"). New sources
 * are cleaned when they are converted (nlp-service routers/conversion.py
 * _clean_title); this puts the same right in sources already saved: every run
 * of whitespace in sources.title becomes one space and the ends are trimmed.
 * A title that is only whitespace is left as it is.
 *
 * Only the sources row changes (one transaction, no file I/O). The title of a
 * source's own page (source-summary) is left alone: it also lives in the page
 * file's frontmatter, the page index and the link map, and a page rewrite
 * (lib/page-rewrite.ts) changes the text, not the name, so changing the row
 * alone would make the file and the database disagree. Source pages are found
 * by their credited sources, not by title, so the two never lose each other.
 */

import type Database from 'better-sqlite3';

export const oneLine = (title: string): string => title.split(/\s+/).filter(Boolean).join(' ');

function dirtyTitles(db: Database.Database): Array<{ source_id: string; clean: string }> {
  return (db.prepare('SELECT source_id, title FROM sources').all() as Array<{ source_id: string; title: string }>)
    .map((r) => ({ source_id: r.source_id, title: r.title, clean: oneLine(r.title) }))
    .filter((r) => r.clean !== '' && r.clean !== r.title);
}

/** How many source titles have stray whitespace. Reads only. */
export function countTitleFixes(db: Database.Database): number {
  return dirtyTitles(db).length;
}

/** Cleans every such title in one transaction; returns how many. */
export function applyTitleFixes(db: Database.Database): number {
  return db.transaction((): number => {
    const set = db.prepare('UPDATE sources SET title = ? WHERE source_id = ?');
    const rows = dirtyTitles(db);
    for (const r of rows) set.run(r.clean, r.source_id);
    return rows.length;
  })();
}
