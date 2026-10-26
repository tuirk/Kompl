/**
 * The wiki's claims, as the claim check reads them (plan 3.3 and 3.6).
 *
 * Each source's extraction lists claims, each with the names it involves
 * (entities_involved) and, from plan 3.2 on, the source's own sentence
 * (quote, checked against the source: quote_verified). A claim's subjects
 * are those names mapped to the wiki's canonical names the way the extract
 * step pins mention rows (lib/mention-pin.ts buildMentionPin): an entity or
 * concept page's title first, then an active alias, else the name as
 * written. Resolve stores every merged name as an alias, so a claim made
 * before or after a merge lands on the same subject.
 *
 * Only sources in the wiki count: compiled ('active') and not archived.
 * Extractions made before quotes have none; old ones without claims add
 * nothing.
 */

import { createHash } from 'node:crypto';
import type Database from 'better-sqlite3';

import { getAliases, getEntityAndConceptPageTitles } from '../db';
import { buildMentionPin, mentionKey } from '../mention-pin';
import { CLAIM_MAX_CHARS } from './limits';

export interface WikiClaim {
  /** Stable id: the source and the claim's text (claimKey). */
  key: string;
  source_id: string;
  /** The claim as the extraction wrote it, clipped to CLAIM_MAX_CHARS. */
  text: string;
  /** The source's own sentence, only when it was found in the source; else null. */
  quote: string | null;
  /** Canonical names of the claim's subjects, one per name (mentionKey). */
  subjects: string[];
}

const str = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const clip = (value: string): string =>
  value.length > CLAIM_MAX_CHARS ? `${value.slice(0, CLAIM_MAX_CHARS - 1).trimEnd()}…` : value;

/**
 * A claim's id: its source and its text (whitespace and case folded),
 * hashed. Re-extracting a source with the same claim keeps the id, so a
 * saved verdict still applies; a reworded claim is a new claim.
 */
export function claimKey(sourceId: string, text: string): string {
  const folded = text.normalize('NFKC').replace(/\s+/g, ' ').trim().toLowerCase();
  return createHash('sha256').update(`${sourceId}\u0000${folded}`).digest('hex').slice(0, 24);
}

/** A pair's id: the two claim keys, sorted, so (a, b) and (b, a) are one pair. */
export function pairKey(a: string, b: string): string {
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

/** One extraction's claims (llm_output parsed), each with its canonical subjects. */
export function claimsOf(sourceId: string, llmOutput: unknown, pin: (name: string) => string): WikiClaim[] {
  const claims = (llmOutput as { claims?: unknown } | null)?.claims;
  if (!Array.isArray(claims)) return [];
  const out: WikiClaim[] = [];
  const seen = new Set<string>();
  for (const raw of claims) {
    if (!raw || typeof raw !== 'object') continue;
    const item = raw as Record<string, unknown>;
    const text = str(item.claim);
    if (!text) continue;
    const key = claimKey(sourceId, text);
    if (seen.has(key)) continue;
    seen.add(key);
    const subjects = new Map<string, string>();
    for (const name of Array.isArray(item.entities_involved) ? item.entities_involved : []) {
      const written = str(name);
      if (!written) continue;
      const canonical = pin(written).trim();
      if (canonical && !subjects.has(mentionKey(canonical))) subjects.set(mentionKey(canonical), canonical);
    }
    const quote = item.quote_verified === true ? str(item.quote) : '';
    out.push({ key, source_id: sourceId, text: clip(text), quote: quote ? clip(quote) : null, subjects: [...subjects.values()] });
  }
  return out;
}

/** Every claim of every source in the wiki, in source order. */
export function loadWikiClaims(db: Database.Database): WikiClaim[] {
  const pin = buildMentionPin(getEntityAndConceptPageTitles(), getAliases());
  const rows = db
    .prepare(
      `SELECT e.source_id, e.llm_output
         FROM extractions e
         JOIN sources s ON s.source_id = e.source_id
        WHERE s.compile_status IN ('active', 'compiled')
          AND COALESCE(s.status, 'active') != 'archived'
        ORDER BY e.source_id`,
    )
    .all() as Array<{ source_id: string; llm_output: string }>;
  return rows.flatMap((row) => {
    let llm: unknown;
    try {
      llm = JSON.parse(row.llm_output);
    } catch {
      return [];
    }
    return claimsOf(row.source_id, llm, pin);
  });
}

/** Entity and concept pages by their title (mentionKey): where a subject's findings go. */
export function subjectPages(db: Database.Database): Map<string, { page_id: string; title: string }> {
  const rows = db
    .prepare(`SELECT page_id, title FROM pages WHERE page_type IN ('entity', 'concept') ORDER BY page_type, page_id`)
    .all() as Array<{ page_id: string; title: string }>;
  const out = new Map<string, { page_id: string; title: string }>();
  for (const row of rows) if (!out.has(mentionKey(row.title))) out.set(mentionKey(row.title), row);
  return out;
}
