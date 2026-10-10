/**
 * Disputes a page records in its own text.
 *
 * Kompl notices a contradiction in two ways. When a new source contradicts
 * an existing page, the compile's triage step logs page_contradiction_detected
 * against it. When a page is drafted from sources that disagree with each
 * other, there is no existing page to flag: the draft records the
 * disagreement in the page itself, in a "Disputed: <topic>" or
 * "Contradictions" section that cites each side (the v0.4 writing rules).
 *
 * This module reads those sections, so the wiki page can list them next to
 * flagged sources, and every commit path can log each new one
 * (page_dispute_recorded) for the activity feed. No LLM calls.
 *
 * A section counts as a dispute only when it cites at least two different
 * sources: a disagreement has two sides.
 */

import { getDb, logActivity } from './db';
import { headingAnchor } from './markdown';
import { parseHeading } from './page-sections';
import { stripWikilinks } from './wikilink-syntax';

export interface PageDispute {
  /** What is disputed: the heading's topic, or the section's first sentence. */
  topic: string;
  /** The section heading's anchor, slugged like the page renderer. */
  anchor: string;
  /**
   * Position of the section heading among the page's ## and ### headings.
   * The page view slugs its anchors after display-time rewrites (wikilinks
   * become text), so it matches disputes to its own anchors by position.
   */
  headingIndex: number;
  /** Distinct sources cited in the section, in order of first citation. */
  sourceIds: string[];
}

/** "Disputed: <topic>", "Contradictions", "Conflicting claims", "Disputes", "Contested: <topic>". */
const DISPUTE_HEADING =
  /^(?:disputed|disputes?|contradictions?|conflicting\s+(?:claims|accounts|sources|reports|information)|contested)\b/i;
/** The topic after "Disputed:" / "Disputed —" / "Contested:". */
const NAMED_TOPIC = /^(?:disputed|contested)\s*[:—–-]\s*(.+)$/i;
/** A stored citation ([^source_id]); numbered footnotes ([^1]) are not sources. */
const CITATION = /\[\^([A-Za-z0-9_-]*[A-Za-z_-][A-Za-z0-9_-]*)\]/g;
/** Same match as the page's table of contents, so the anchors agree. */
const SECTION_HEADING = /^(#{2,3})\s+(.+?)(?:\s+#+)?\s*$/;
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

/** Disputes recorded in a page's markdown (stored or display form), in page order. */
export function findPageDisputes(markdown: string): PageDispute[] {
  const lines = markdown.split('\n');
  let start = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === '---');
    if (end > 0) start = end + 1;
  }

  const disputes: PageDispute[] = [];
  let inFence = false;
  let headingIndex = -1;
  for (let i = start; i < lines.length; i++) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const match = line.match(SECTION_HEADING);
    if (!match) continue;
    headingIndex++;
    const heading = parseHeading(line);
    if (!heading || !DISPUTE_HEADING.test(heading.text)) continue;

    // The section runs to the next heading of the same or a higher level.
    const level = match[1].length;
    const body: string[] = [];
    let fence = false;
    for (let j = i + 1; j < lines.length; j++) {
      const next = lines[j];
      if (next.trimStart().startsWith('```')) {
        fence = !fence;
        continue;
      }
      // Code is not prose: what looks like a citation or heading in it is neither.
      if (fence) continue;
      const h = next.match(/^(#{1,6})\s/);
      if (h && h[1].length <= level) break;
      body.push(next);
    }
    const text = body.join('\n');

    const sourceIds: string[] = [];
    for (const cite of text.matchAll(CITATION)) {
      if (!sourceIds.includes(cite[1])) sourceIds.push(cite[1]);
    }
    if (sourceIds.length < MIN_SOURCES) continue;

    const named = heading.text.match(NAMED_TOPIC)?.[1]?.trim();
    const topic = capitalise(named || firstSentence(text) || heading.text);
    disputes.push({ topic, anchor: headingAnchor(match[2]), headingIndex, sourceIds });
  }
  return disputes;
}

function sameSources(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('\n') === [...b].sort().join('\n');
}

/**
 * Log page_dispute_recorded for each dispute the page's text records that was
 * not logged for this page before: neither the same topic nor the same set of
 * sources (a dispute the model words differently on the next update is not
 * new). Called after a commit's transaction (Phase 3b); never throws.
 * Returns how many were logged.
 */
export function recordNewDisputes(page: { page_id: string; title: string }, markdown: string): number {
  try {
    const disputes = findPageDisputes(markdown);
    if (disputes.length === 0) return 0;
    const logged = (
      getDb()
        .prepare(
          `SELECT details FROM activity_log
            WHERE action_type = 'page_dispute_recorded'
              AND json_extract(details, '$.page_id') = ?`,
        )
        .all(page.page_id) as Array<{ details: string | null }>
    ).map((row) => {
      try {
        const d = JSON.parse(row.details ?? '{}') as { topic?: unknown; source_ids?: unknown };
        return {
          topic: typeof d.topic === 'string' ? d.topic.toLowerCase() : '',
          sourceIds: Array.isArray(d.source_ids) ? d.source_ids.filter((s): s is string => typeof s === 'string') : [],
        };
      } catch {
        return { topic: '', sourceIds: [] as string[] };
      }
    });

    let count = 0;
    for (const dispute of disputes) {
      const topic = dispute.topic.toLowerCase();
      if (logged.some((l) => l.topic === topic || sameSources(l.sourceIds, dispute.sourceIds))) continue;
      logActivity('page_dispute_recorded', {
        source_id: null,
        details: {
          page_id: page.page_id,
          title: page.title,
          topic: dispute.topic,
          anchor: dispute.anchor,
          source_ids: dispute.sourceIds,
        },
      });
      logged.push({ topic, sourceIds: dispute.sourceIds });
      count++;
    }
    return count;
  } catch (err) {
    console.error('[page-disputes] could not record disputes', page.page_id, err);
    return 0;
  }
}
