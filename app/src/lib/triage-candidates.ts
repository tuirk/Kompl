/**
 * Which existing pages the match step triages a session source against
 * (plan 3.5).
 *
 * Pages whose subject the source names come first: an entity or concept
 * page whose title is one of the names the source's entity_mentions rows
 * hold (resolve rebuilds them through its groups, so "ETH" reads as the
 * "Ethereum" page it was resolved to), and a comparison page "A vs B" whose
 * two ends both are. They rank by how many of the source's claims are about
 * the subject, then by TF-IDF similarity of the source to the page, then by
 * title. Pages TF-IDF finds above TFIDF_MIN_SIMILARITY fill the slots left.
 *
 * Each candidate is one triage LLM call; the cap per source is the same as
 * when TF-IDF alone chose them, so a compile makes no more calls than
 * before (CLAUDE.md rule 7).
 */

import { getDb } from './db';
import { mentionKey } from './mention-pin';
import { pageSubjects, type TriagePage } from './triage-evidence';

/** Triage calls per session source at most. */
export const MAX_TRIAGE_CANDIDATES_PER_SOURCE = 3;

/**
 * TF-IDF similarity a page needs to be a candidate without a shared entity.
 * Calibrated on 2026-05-08 for long sources (~50K chars) against short
 * pages (~2K chars): a 58K-char paper on the favourite-longshot bias scored
 * 0.208 / 0.185 / 0.137 / 0.118 against a 20-page prediction-markets wiki,
 * and the right page and a coauthor's page were both under the earlier 0.3.
 * The triage LLM is the precision filter.
 */
export const TFIDF_MIN_SIMILARITY = 0.15;

/** The names (mentionKey) a source's mention rows hold. */
export function namesInSource(sourceId: string): Set<string> {
  const rows = getDb()
    .prepare('SELECT canonical_name FROM entity_mentions WHERE source_id = ?')
    .all(sourceId) as Array<{ canonical_name: string }>;
  return new Set(rows.map((r) => mentionKey(r.canonical_name)));
}

/** Does the source name the page's subject (both ends of a comparison)? */
export function sharesSubject(page: Pick<TriagePage, 'title' | 'page_type'>, named: Set<string>): boolean {
  if (page.page_type === 'entity' || page.page_type === 'concept') return named.has(mentionKey(page.title));
  if (page.page_type === 'comparison') {
    const ends = pageSubjects(page);
    return ends.length === 2 && ends.every((end) => named.has(mentionKey(end)));
  }
  return false;
}

export interface SharedCandidate {
  page_id: string;
  title: string;
  /** The source's claims about the page's subject. */
  claims: number;
}

/**
 * The page ids to triage, best first: shared-entity pages by claims, then
 * similarity, then title; then TF-IDF matches above the threshold by
 * similarity. At most MAX_TRIAGE_CANDIDATES_PER_SOURCE.
 */
export function pickTriageCandidates(
  shared: SharedCandidate[],
  tfidf: Array<{ page_id: string; similarity: number }>,
): string[] {
  const similarity = new Map(tfidf.map((m) => [m.page_id, m.similarity]));
  const sim = (pageId: string) => similarity.get(pageId) ?? 0;
  const ranked = [...shared]
    .sort((a, b) => b.claims - a.claims || sim(b.page_id) - sim(a.page_id) || a.title.localeCompare(b.title))
    .map((c) => c.page_id);
  const picked = new Set(ranked.slice(0, MAX_TRIAGE_CANDIDATES_PER_SOURCE));
  for (const m of [...tfidf].sort((a, b) => b.similarity - a.similarity)) {
    if (picked.size >= MAX_TRIAGE_CANDIDATES_PER_SOURCE) break;
    if (m.similarity > TFIDF_MIN_SIMILARITY) picked.add(m.page_id);
  }
  return [...picked];
}
