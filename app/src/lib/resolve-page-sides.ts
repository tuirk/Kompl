/**
 * What Layer 3 reads about a pair side bound to a wiki page: the page
 * itself (an existing-page side) or a group bound to it. The side's context
 * becomes the page's own summary and its known_names the page's active
 * stored aliases (nlp-service/routers/resolution.py DisambiguateSide).
 * Before, a page side went with no context, and a group bound to a page
 * with one source's sentence: "a broader term" for "Color Vision
 * Deficiency" kept "colorblindness" apart from it, though the page's
 * stored alias was "Colour-blindness" (film run, 2026-10-25).
 */

// Bounds on what one side adds to a Layer 3 prompt. Page summaries run
// about 200 characters (the longest in the film wiki 339); a page carries
// one to three stored aliases.
export const MAX_PAGE_SUMMARY_CHARS = 600;
export const MAX_KNOWN_NAMES = 10;

export interface PageRow {
  title: string;
  page_type: string;
  summary: string | null;
}

export interface PageSide {
  summary: string;      // '' when no page row or no summary: the side keeps its context
  known_names: string[];
}

const key = (name: string) => name.normalize('NFKC').trim().toLowerCase();

/**
 * A lookup from a bound side's title and kind to what Layer 3 reads about
 * its page. A title naming an entity and a concept page takes the page of
 * the side's kind. Known names leave out the title itself and repeat no
 * name; `aliases` are getAliases() rows (active only, oldest first).
 */
export function pageSide(
  pages: PageRow[],
  aliases: Array<{ alias: string; canonical_name: string }>,
): (title: string, type: string) => PageSide {
  const byTitle = new Map<string, PageRow[]>();
  for (const p of pages) byTitle.set(key(p.title), [...(byTitle.get(key(p.title)) ?? []), p]);
  const namesOf = new Map<string, string[]>();
  for (const a of aliases) {
    const names = namesOf.get(key(a.canonical_name)) ?? [];
    if (key(a.alias) !== key(a.canonical_name) && !names.some((n) => key(n) === key(a.alias))) names.push(a.alias);
    namesOf.set(key(a.canonical_name), names);
  }
  return (title, type) => {
    const rows = byTitle.get(key(title)) ?? [];
    const kind = type === 'CONCEPT' ? 'concept' : 'entity';
    const page = rows.find((p) => p.page_type === kind) ?? rows[0];
    return {
      summary: (page?.summary ?? '').trim().slice(0, MAX_PAGE_SUMMARY_CHARS),
      known_names: (namesOf.get(key(title)) ?? []).slice(0, MAX_KNOWN_NAMES),
    };
  };
}
