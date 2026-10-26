/**
 * Disputes a page records in its own text.
 *
 * Kompl notices a contradiction in two ways. When a new source contradicts
 * an existing page, the compile's triage step logs page_contradiction_detected
 * against it. When a page is drafted from sources that disagree with each
 * other, there is no existing page to flag: the draft records the
 * disagreement in the page itself, under "### Disputed: <topic>" (a live
 * disagreement) or "### Changed: <topic>" (a claim a later source
 * superseded), each side cited (the draft prompts, plan 3.1).
 *
 * This module reads those sections. Every commit path records them in the
 * disagreements record from the committed text (lib/disagreements.ts),
 * which logs each new one (page_dispute_recorded) for the activity feed.
 * No LLM calls.
 *
 * Pages written before the one format, or by a model that strayed from it,
 * word their headings differently ("Founding date (disputed)", "Conflicting
 * claims", "#### Contradictions"), so the keyword counts anywhere in a
 * heading of any level, in any case. A section counts as a dispute only
 * when it cites at least two different sources: a disagreement has two
 * sides. A section whose sub-sections are disputes ("## Contradictions"
 * holding "### Disputed: …") is not one of its own.
 */

import { headingAnchor } from './markdown';
import { parseHeading } from './page-sections';
import { stripWikilinks } from './wikilink-syntax';

/** Disputed: a live disagreement. Changed: a claim a later source superseded. */
export type PageDisputeKind = 'disputed' | 'changed';

export interface PageDispute {
  kind: PageDisputeKind;
  /** What is disputed: the heading's topic, or the section's first sentence. */
  topic: string;
  /** The section heading's anchor, slugged like the page renderer. */
  anchor: string;
  /**
   * Position of the section heading among the page's ## and ### headings,
   * or -1 for a heading at another level. The page view slugs its anchors
   * after display-time rewrites (wikilinks become text), so it matches
   * disputes to its own anchors by position.
   */
  headingIndex: number;
  /** Distinct sources cited in the section, in order of first citation. */
  sourceIds: string[];
}

/** Words that make a heading a dispute, anywhere in it. */
const DISPUTE_WORD =
  /\b(?:disputed?|disputes|contested|contradict(?:ions?|ory|s|ed)?|conflicting\s+(?:claims|accounts|sources|reports|information|views|figures|dates)|disagree(?:s|ments?)?)\b/i;
/**
 * A change over time only as a heading's lead or tail ("Changed: X",
 * "X (changed)"): "What changed in 2024" is an ordinary section (owner, 2026-10-24).
 */
const CHANGED_WORD = /^changed\b|\s*(?:[([]\s*changed\s*[)\]]|[:—–-]\s*changed)$/i;
/** "Founding date (disputed)", "Population — changed", "Size: contested". */
const TRAILING_KEYWORD = /\s*(?:[([]\s*(?:disputed|contested|changed)\s*[)\]]|[:—–-]\s*(?:disputed|contested|changed))$/i;
/** "Disputed: X", "Changed — X", "Contradictions", "Disputes over X". */
const LEADING_KEYWORD =
  /^(?:disputed|disputes?|contested|contradictions?|contradictory|conflicting\s+(?:claims|accounts|sources|reports|information|views|figures|dates)|disagreements?|changed)\b\s*[:—–-]?\s*/i;
/** What may follow a leading keyword before the topic: "claims about", "over". */
const LEAD_FILLER =
  /^(?:(?:claims?|accounts?|reports?|information|points?|facts?|figures?)\b\s*)?(?:(?:over|about|on|regarding|concerning|around|in|of|between)\s+)?/i;
/** A remainder that names no topic. */
const NO_TOPIC = /^(?:(?:the\s+)?(?:sources?|claims?|accounts?|reports?))?$/i;
/** A stored citation ([^source_id]); numbered footnotes ([^1]) are not sources. */
const CITATION = /\[\^([A-Za-z0-9_-]*[A-Za-z_-][A-Za-z0-9_-]*)\]/g;
/** Any markdown heading; the table of contents lists levels 2 and 3. */
const SECTION_HEADING = /^(#{1,6})\s+(.+?)(?:\s+#+)?\s*$/;
const MIN_SOURCES = 2;
const TOPIC_MAX = 120;

function plainText(markdown: string): string {
  return stripWikilinks(markdown)
    .replace(CITATION, '')
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    .replace(/[*_`]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

function capitalise(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

/** The first sentence of a section, for headings that don't name a topic. */
function firstSentence(body: string): string {
  for (const raw of body.split('\n')) {
    const trimmed = raw.trim();
    if (!trimmed || trimmed.startsWith('|') || trimmed.startsWith('#')) continue;
    const text = plainText(trimmed.replace(/^(?:[-*+]|\d+[.)])\s+/, ''));
    if (!text) continue;
    const sentence = text.match(/^(.+?[.!?])(?:\s|$)/)?.[1] ?? text;
    return sentence.length > TOPIC_MAX ? `${sentence.slice(0, TOPIC_MAX - 1).trimEnd()}…` : sentence;
  }
  return '';
}

/** Disputed or Changed, by the keyword that comes first; null when the heading has neither. */
function headingKind(text: string): PageDisputeKind | null {
  const dispute = text.search(DISPUTE_WORD);
  const changed = text.search(CHANGED_WORD);
  if (dispute < 0 && changed < 0) return null;
  if (dispute < 0) return 'changed';
  if (changed < 0) return 'disputed';
  return changed < dispute ? 'changed' : 'disputed';
}

/** The topic a heading names around its keyword; '' when it names none. */
function headingTopic(text: string): string {
  const trailing = text.replace(TRAILING_KEYWORD, '');
  if (trailing !== text) return trailing.trim();
  const lead = text.match(LEADING_KEYWORD);
  if (!lead) return text;
  const rest = text.slice(lead[0].length).replace(LEAD_FILLER, '').trim();
  return NO_TOPIC.test(rest) ? '' : rest;
}

interface HeadingLine {
  line: number;
  level: number;
  raw: string;
  /** Position among ## and ### headings, -1 for other levels. */
  tocIndex: number;
  kind: PageDisputeKind | null;
  text: string;
}

/**
 * A dispute topic as compared with a stored one: case, curly quotes and
 * dashes, spacing and edge punctuation fold away, so a rewrite that only
 * retypes the apostrophe (APCA's / APCA’s) is the same finding.
 */
export function topicKey(topic: string): string {
  return topic
    .normalize('NFKC')
    .toLowerCase()
    .replace(/[‘’‚‛′`´]/g, "'")
    .replace(/[“”„‟″]/g, '"')
    .replace(/[‐-―−]/g, '-')
    .replace(/\s+/g, ' ')
    .replace(/^[\s"'.,:;!?-]+|[\s"'.,:;!?-]+$/g, '');
}

/** The same set of cited sources, in any order. */
export function sameSources(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}

/**
 * The stored finding each dispute continues, by position (undefined for a
 * new one): the same topic first, across all the disputes, then the same
 * cited sources for the rest (the model rewords between updates). Two
 * sections often cite the same pair of sources, so a source match taken
 * first would hand a dropped or moved section's finding, verdict and all,
 * to its neighbour. Each stored finding continues at most one dispute.
 */
export function matchStoredDisputes<T extends { topic: string; source_ids: readonly string[] }>(
  disputes: readonly PageDispute[],
  stored: readonly T[],
): Array<T | undefined> {
  const used = new Set<T>();
  const take = (found: T | undefined): T | undefined => {
    if (found) used.add(found);
    return found;
  };
  const matches = disputes.map((d) => {
    const topic = topicKey(d.topic);
    return take(stored.find((s) => !used.has(s) && topicKey(s.topic) === topic));
  });
  return matches.map(
    (match, i) => match ?? take(stored.find((s) => !used.has(s) && sameSources(s.source_ids, disputes[i].sourceIds))),
  );
}

/**
 * A page's lines, its headings outside code (what looks like a heading in
 * code is not one) after any frontmatter, and the lines that are code.
 */
function scanHeadings(markdown: string): { lines: string[]; headings: HeadingLine[]; isCode: boolean[] } {
  const lines = markdown.split('\n');
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === '---');
    if (end > 0) start = end + 1;
  }

  const headings: HeadingLine[] = [];
  const isCode = new Array<boolean>(lines.length).fill(false);
  let inFence = false;
  let tocIndex = -1;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      isCode[i] = true;
      continue;
    }
    if (inFence) {
      isCode[i] = true;
      continue;
    }
    const match = line.match(SECTION_HEADING);
    if (!match) continue;
    const level = match[1].length;
    if (level === 2 || level === 3) tocIndex++;
    const text = parseHeading(line)?.text ?? '';
    headings.push({
      line: i,
      level,
      raw: match[2],
      tocIndex: level === 2 || level === 3 ? tocIndex : -1,
      kind: text ? headingKind(text) : null,
      text,
    });
  }
  return { lines, headings, isCode };
}

/**
 * The lines under a PageDispute's headingIndex (the page's
 * headingIndex-th ## or ### heading) up to the next heading of any level,
 * code left out; [] when there is no such heading.
 */
export function sectionLines(markdown: string, headingIndex: number): string[] {
  const { lines, headings, isCode } = scanHeadings(markdown);
  const h = headingIndex < 0 ? -1 : headings.findIndex((heading) => heading.tocIndex === headingIndex);
  if (h < 0) return [];
  const end = h + 1 < headings.length ? headings[h + 1].line : lines.length;
  const out: string[] = [];
  for (let i = headings[h].line + 1; i < end; i++) if (!isCode[i]) out.push(lines[i]);
  return out;
}

/** Disputes recorded in a page's markdown (stored or display form), in page order. */
export function findPageDisputes(markdown: string): PageDispute[] {
  const { lines, headings, isCode } = scanHeadings(markdown);
  const disputes: PageDispute[] = [];
  headings.forEach((heading, h) => {
    if (!heading.kind) return;
    // The section runs to the next heading of the same or a higher level.
    let next = h + 1;
    while (next < headings.length && headings[next].level > heading.level) next++;
    // Its own sub-sections record the disputes.
    if (headings.slice(h + 1, next).some((sub) => sub.kind)) return;
    const end = next < headings.length ? headings[next].line : lines.length;
    const body = lines.slice(heading.line + 1, end).filter((_, offset) => !isCode[heading.line + 1 + offset]);
    const text = body.join('\n');

    const sourceIds: string[] = [];
    for (const cite of text.matchAll(CITATION)) {
      if (!sourceIds.includes(cite[1])) sourceIds.push(cite[1]);
    }
    if (sourceIds.length < MIN_SOURCES) return;

    const topic = capitalise(headingTopic(heading.text) || firstSentence(text) || heading.text);
    disputes.push({
      kind: heading.kind,
      topic,
      anchor: headingAnchor(heading.raw),
      headingIndex: heading.tocIndex,
      sourceIds,
    });
  });
  return disputes;
}
