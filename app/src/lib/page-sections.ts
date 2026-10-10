/**
 * Section-level reading of compiled page markdown: headings, "Related" lists,
 * and contradiction sections that only say there are none.
 *
 * Shared by draft-time cleanup (draft-cleanup.ts) and page display
 * (wiki-display.ts) so a stored page and a displayed page follow the same
 * rules.
 */

import { healedPageBody } from './markdown';
import { stripWikilinks } from './wikilink-syntax';

/**
 * Page types the LLM writes by combining sources. Their structure (Related
 * lists, Contradictions sections) comes from Kompl's own templates, so cleanup
 * may touch it. Source pages reproduce a source's own text and are left alone.
 */
export const SYNTHESIZED_PAGE_TYPES: ReadonlySet<string> = new Set(['entity', 'concept', 'comparison', 'overview']);

/**
 * Page body as displayed: healed legacy wrappers, and for pages the LLM
 * synthesizes, no Contradictions section that only says there are none.
 * Stored markdown is never changed. The page view and the page-data API (MCP
 * read_page) both use it, so their citation numbers agree.
 */
export function displayPageBody(raw: string, pageType: string): string {
  const body = healedPageBody(raw);
  return SYNTHESIZED_PAGE_TYPES.has(pageType) ? removeEmptyContradictionSections(body).markdown : body;
}

export interface Heading {
  level: number;
  /** Heading text without emphasis, wikilink syntax or a trailing colon. */
  text: string;
}

const HEADING = /^(#{1,6})\s+(.*?)\s*#*\s*$/;

export function parseHeading(line: string): Heading | null {
  const m = line.match(HEADING);
  if (!m) return null;
  const text = stripWikilinks(m[2])
    .replace(/[*_`]/g, '')
    .replace(/:\s*$/, '')
    .trim();
  return { level: m[1].length, text };
}

const RELATED_TEXT =
  /^(?:related(?:\s+(?:concepts?|pages?|topics?|entities|articles|terms))?|see\s+also|further\s+reading)$/i;

/** "Related Concepts", "See also" and similar navigation lists. */
export function isRelatedHeading(heading: Heading): boolean {
  return RELATED_TEXT.test(heading.text);
}

// A heading with a topic ("Disputed: Python creation timeline") never matches,
// so real disputes are never treated as empty.
const CONTRADICTION_TEXT = /^(?:contradictions?|conflicting\s+claims|disputes?|disputed(?:\s+claims)?)$/i;

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const LEAD_NONE = /^(?:none|n\/a)(?:\s+(?:found|identified|noted|known))?\s*(?:[.;:—–-]\s*|$)/i;
const LEAD_NO =
  /^(?:there\s+(?:are|were)\s+no|no)\s+(?:(?:known|direct|significant|major|apparent|notable|factual)\s+)?(?:contradictions?|conflicts?|conflicting\s+claims|disagreements?|discrepancies|inconsistencies)\b/i;
const AGREE = /\b(?:agree[sd]?|agreement|consistent|concur\w*|align\w*)\b/i;
const SIGNAL =
  /\b(?:however|but|although|though|whereas|while|yet|except|disagree\w*|conflict\w*|contradict\w*|differ\w*|discrepan\w*|disput\w*|inconsisten\w*|versus|vs)\b/i;

/**
 * True when a contradiction section's body only says there is nothing to
 * report ("None.", "No contradictions found among the sources…", "None. Both
 * sources agree…"). Anything that cites a source, has structure, is long, or
 * hints at a disagreement is kept.
 */
function isEmptyContradictionBody(body: string[]): boolean {
  const lines = body.filter((l) => l.trim() !== '');
  if (lines.length === 0) return true;
  if (lines.some((l) => /^\s*#{1,6}\s/.test(l) || l.trimStart().startsWith('```') || /^\s*\|/.test(l))) {
    return false;
  }
  const joined = lines.join(' ');
  if (UUID.test(joined) || /\[\^[^\]]+\]/.test(joined) || /\[S\d+\]/i.test(joined)) return false;
  if (joined.length > 300) return false;
  const text = stripWikilinks(joined)
    .replace(/^\s*(?:[-*+]|\d+\.)\s+/, '')
    .replace(/[*_]/g, '')
    .trim();
  const none = text.match(LEAD_NONE);
  if (none) {
    const rest = text.slice(none[0].length).trim();
    return rest === '' || (AGREE.test(rest) && !SIGNAL.test(rest));
  }
  const no = text.match(LEAD_NO);
  if (no) return !SIGNAL.test(text.slice(no[0].length));
  return false;
}

/**
 * Remove "Contradictions" sections (any heading level) whose body only says
 * there are none. The section runs to the next heading of the same or a
 * higher level. Frontmatter and fenced code are left alone.
 */
export function removeEmptyContradictionSections(markdown: string): { markdown: string; removed: number } {
  const lines = markdown.split('\n');
  const out: string[] = [];
  let i = 0;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, idx) => idx > 0 && l.trim() === '---');
    if (end > 0) {
      out.push(...lines.slice(0, end + 1));
      i = end + 1;
    }
  }
  let removed = 0;
  let inFence = false;
  while (i < lines.length) {
    const line = lines[i];
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    const heading = inFence ? null : parseHeading(line);
    if (heading && CONTRADICTION_TEXT.test(heading.text)) {
      let j = i + 1;
      let fence = false;
      while (j < lines.length) {
        const l = lines[j];
        if (l.trimStart().startsWith('```')) fence = !fence;
        else if (!fence) {
          const next = parseHeading(l);
          if (next && next.level <= heading.level) break;
        }
        j++;
      }
      if (isEmptyContradictionBody(lines.slice(i + 1, j))) {
        removed++;
        while (out.length > 0 && out[out.length - 1].trim() === '') out.pop();
        if (j < lines.length) out.push('');
        i = j;
        continue;
      }
    }
    out.push(line);
    i++;
  }
  return { markdown: removed > 0 ? out.join('\n') : markdown, removed };
}
