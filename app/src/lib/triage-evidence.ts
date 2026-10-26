/**
 * What a match triage call judges a (source, page) pair on (plan 3.5).
 *
 * The claims the source's extraction makes about the page's subject, each
 * with the source's own sentence when the extraction kept one (`quote`), and
 * the page's section most related to them. A claim is about the subject when
 * its entities_involved names the subject or one of its aliases, or its text
 * does. A comparison page ("A vs B") has two subjects.
 *
 * A source whose extraction makes no claim about the subject (no extraction,
 * an old one without claims, or claims about other things) is judged on its
 * text, as triage always was.
 */

import { getAliases, getExtraction, readPageMarkdown } from './db';
import { healedPageBody } from './markdown';
import { mentionKey } from './mention-pin';
import { isRelatedHeading, parseHeading } from './page-sections';

/** Most claims one triage call carries; claims naming the subject come first. */
export const MAX_TRIAGE_CLAIMS = 12;
/** Longest claim or source sentence sent, in characters. */
export const TRIAGE_CLAIM_MAX_CHARS = 400;
/** Most page text sent as the related section, in characters. */
export const TRIAGE_SECTION_MAX_CHARS = 3000;
/** Shorter names are not looked for inside a claim's text ("AI" in "said"). */
const MIN_NAME_IN_TEXT = 3;

export interface TriageClaim {
  claim: string;
  /** The source's own sentence; null when the extraction kept none. */
  quote: string | null;
}

export interface TriageInput {
  evidence: 'claims' | 'source_text';
  /** The claims as the prompt lists them, or the source's text. */
  source_claims: string;
  /** The page's section(s) most related to the claims; '' with source_text. */
  page_section: string;
}

/** Page shape the subject is read from. */
export interface TriagePage {
  page_id: string;
  title: string;
  page_type: string;
}

const text = (value: unknown): string => (typeof value === 'string' ? value.trim() : '');
const clip = (value: string): string =>
  value.length > TRIAGE_CLAIM_MAX_CHARS ? `${value.slice(0, TRIAGE_CLAIM_MAX_CHARS - 1).trimEnd()}…` : value;
const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** Active aliases by canonical (mentionKey), read once per match step. */
export function triageAliases(): Map<string, string[]> {
  const byCanonical = new Map<string, string[]>();
  for (const { alias, canonical_name } of getAliases()) {
    const key = mentionKey(canonical_name);
    byCanonical.set(key, [...(byCanonical.get(key) ?? []), alias]);
  }
  return byCanonical;
}

/** The page's subjects: its title, or both ends of "A vs B" for a comparison. */
export function pageSubjects(page: Pick<TriagePage, 'title' | 'page_type'>): string[] {
  if (page.page_type === 'comparison') {
    const at = page.title.indexOf(' vs ');
    if (at > 0) return [page.title.slice(0, at).trim(), page.title.slice(at + 4).trim()].filter(Boolean);
  }
  return [page.title];
}

/** The names a claim may use for the page's subjects: each subject and its aliases. */
export function subjectNames(page: Pick<TriagePage, 'title' | 'page_type'>, aliases: Map<string, string[]>): string[] {
  return pageSubjects(page).flatMap((s) => [s, ...(aliases.get(mentionKey(s)) ?? [])]);
}

/**
 * The extraction's claims about any of `names`, at most MAX_TRIAGE_CLAIMS:
 * claims whose entities_involved names one first, then claims whose text
 * does, each group in extraction order.
 */
export function claimsAbout(extraction: unknown, names: string[]): TriageClaim[] {
  const claims = (extraction as { claims?: unknown } | null)?.claims;
  if (!Array.isArray(claims) || names.length === 0) return [];
  const keys = new Set(names.map(mentionKey));
  const inText = names
    .map((n) => n.trim())
    .filter((n) => n.length >= MIN_NAME_IN_TEXT)
    .map((n) => new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(n)}(?![\\p{L}\\p{N}])`, 'iu'));

  const named: TriageClaim[] = [];
  const mentioned: TriageClaim[] = [];
  for (const c of claims) {
    if (!c || typeof c !== 'object') continue;
    const item = c as Record<string, unknown>;
    const claim = text(item.claim);
    if (!claim) continue;
    const entry = { claim: clip(claim), quote: text(item.quote) ? clip(text(item.quote)) : null };
    const involved = Array.isArray(item.entities_involved) ? item.entities_involved : [];
    if (involved.some((n) => typeof n === 'string' && keys.has(mentionKey(n)))) named.push(entry);
    else if (inText.some((re) => re.test(claim))) mentioned.push(entry);
  }
  return [...named, ...mentioned].slice(0, MAX_TRIAGE_CLAIMS);
}

/** The claims as the triage prompt lists them. */
export function formatClaims(claims: TriageClaim[]): string {
  return claims
    .map((c) => (c.quote && c.quote !== c.claim ? `- ${c.claim}\n  Source sentence: "${c.quote}"` : `- ${c.claim}`))
    .join('\n');
}

const STOPWORDS = new Set([
  'about', 'after', 'also', 'among', 'been', 'before', 'being', 'between', 'both', 'could', 'does', 'each',
  'from', 'have', 'into', 'more', 'most', 'only', 'other', 'over', 'same', 'some', 'such', 'than', 'that',
  'their', 'them', 'then', 'there', 'these', 'they', 'this', 'those', 'through', 'under', 'very', 'were',
  'what', 'when', 'where', 'which', 'while', 'will', 'with', 'would', 'source', 'sources',
]);

function words(value: string): Set<string> {
  return new Set(
    value
      .toLowerCase()
      .split(/[^\p{L}\p{N}]+/u)
      .filter((w) => w.length >= 4 && !STOPWORDS.has(w)),
  );
}

const NOT_CONTENT = /^(?:sources?|references|citations|notes)$/i;

/**
 * The page's section (split at #, ## and ### headings) that shares the most
 * words with the claims, cut to TRIAGE_SECTION_MAX_CHARS, plus any other
 * section at least half as related that still fits, in page order. Source
 * lists and "Related" lists are left out. '' when no section shares a word.
 */
export function relevantPageSection(pageMarkdown: string | null, claims: TriageClaim[]): string {
  if (!pageMarkdown || claims.length === 0) return '';
  const sections: Array<{ heading: string | null; lines: string[] }> = [{ heading: null, lines: [] }];
  for (const line of healedPageBody(pageMarkdown).split('\n')) {
    const heading = parseHeading(line);
    if (heading && heading.level <= 3) sections.push({ heading: heading.text, lines: [line] });
    else sections[sections.length - 1].lines.push(line);
  }
  const wanted = words(claims.map((c) => `${c.claim} ${c.quote ?? ''}`).join(' '));
  const scored = sections
    .map((s, index) => {
      const body = s.lines.join('\n').trim();
      const skip =
        !body || (s.heading !== null && (NOT_CONTENT.test(s.heading) || isRelatedHeading({ level: 2, text: s.heading })));
      const score = skip ? 0 : [...words(body)].filter((w) => wanted.has(w)).length;
      return { index, body, score };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.index - b.index);

  const picked: typeof scored = [];
  let used = 0;
  for (const s of scored) {
    if (picked.length === 0) {
      const body = s.body.slice(0, TRIAGE_SECTION_MAX_CHARS);
      picked.push({ ...s, body });
      used = body.length;
    } else if (s.score * 2 >= picked[0].score && used + 2 + s.body.length <= TRIAGE_SECTION_MAX_CHARS) {
      picked.push(s);
      used += 2 + s.body.length;
    }
  }
  return picked
    .sort((a, b) => a.index - b.index)
    .map((s) => s.body)
    .join('\n\n');
}

/** Claims when the source makes any about the page's subject, else its text. */
export function triageInput(sourceText: string, claims: TriageClaim[], pageMarkdown: string | null): TriageInput {
  if (claims.length === 0) return { evidence: 'source_text', source_claims: sourceText, page_section: '' };
  return {
    evidence: 'claims',
    source_claims: formatClaims(claims),
    page_section: relevantPageSection(pageMarkdown, claims),
  };
}

/** A source's parsed extraction (llm_output), or null without a usable one. */
export function readExtraction(sourceId: string): unknown {
  const row = getExtraction(sourceId);
  if (!row?.llm_output) return null;
  try {
    return JSON.parse(row.llm_output) as unknown;
  } catch {
    return null;
  }
}

/** The triage input for a source (its text and parsed extraction) against a page. */
export function readTriageInput(
  sourceText: string,
  extraction: unknown,
  page: TriagePage,
  aliases: Map<string, string[]>,
): TriageInput {
  const claims = claimsAbout(extraction, subjectNames(page, aliases));
  return triageInput(sourceText, claims, claims.length > 0 ? readPageMarkdown(page.page_id) : null);
}
