/**
 * A topic pack for MCP research_topic: the pages most relevant to a topic,
 * each with its summary and the lines that best match the topic, how those
 * pages connect (typed relations with their sources), one source list
 * numbered across all of them, the disputes those pages record, and gaps
 * around the topic. One call instead of a search plus a read per page,
 * built from what Kompl already holds: no LLM.
 */

import { scanCitations } from './citations';
import { citedSentences, clipCited, hasCitationPlaceholder, lineKey, placeholdersToSharedText } from './cited-text';
import { getDb, readPageMarkdown } from './db';
import { SOURCE_PAGE_TYPES } from './draft-cleanup';
import { topicTerms } from './fts-query';
import { hybridSearch } from './hybrid-search';
import { findPageDisputes } from './page-disputes';
import { displayPageBody, SYNTHESIZED_PAGE_TYPES } from './page-sections';
import { getSourceTitleSet } from './page-sources';
import { relationLabel } from './relation-labels';
import { getRelationsAmong, type RelationEnd } from './relations';
import { runHealthChecksCached } from './wiki-health';
import { stripWikilinks } from './wikilink-syntax';

/** Pages in the pack and key lines per page, by detail level. */
const DETAIL = {
  brief: { pages: 5, lines: 3 },
  full: { pages: 10, lines: 6 },
} as const;
export type ResearchDetail = keyof typeof DETAIL;

/** Further matching pages named (not quoted) after the pack. */
const MORE_PAGES = 5;
/** Names with no page listed with the pack. */
const MISSING_SHOWN = 5;
/** Quoted text per line; its citation markers come on top. */
const MAX_LINE_CHARS = 380;
/** Relations listed under "How these pages connect", and source numbers given per relation. */
const CONNECTIONS_SHOWN = 12;
const SOURCES_PER_CONNECTION = 3;

export interface ResearchPage {
  page_id: string;
  title: string;
  page_type: string;
  category: string | null;
  summary: string | null;
  last_updated: string;
  /** Lines most relevant to the topic, with shared [n] numbers. */
  key_lines: string[];
  /** What the page itself records as disputed. */
  disputes: string[];
  /** A synthesized page resting on a single source. */
  thin: boolean;
}

export interface ResearchSource {
  n: number;
  source_id: string;
  title: string;
  source_url: string | null;
  date_ingested: string | null;
}

/** A typed relation between two pages, at least one of them in the pack. */
export interface ResearchConnection {
  from: RelationEnd;
  to: RelationEnd;
  type: string;
  /** Read from `from`: "Uses", "Part of", "Created by". */
  label: string;
  source_count: number;
  /** Shared [n] numbers of up to 3 of its sources, the sentence's source first. */
  sources: number[];
  sentence: string | null;
}

export interface ResearchPack {
  topic: string;
  degraded: boolean;
  pages: ResearchPage[];
  sources: ResearchSource[];
  missing_pages: Array<{ name: string; mentions: number }>;
  more_pages: Array<{ page_id: string; title: string; page_type: string }>;
  /** Strongest first: specific relations before "related to" (left out where a specific one joins the pair), then most sources. */
  connections: ResearchConnection[];
}

export async function researchTopic(topic: string, detail: ResearchDetail): Promise<ResearchPack> {
  const size = DETAIL[detail];
  const { items, degraded } = await hybridSearch(topic, { limit: size.pages + MORE_PAGES });
  const chosen = items.slice(0, size.pages);
  const terms = topicTerms(topic).map((t) => t.toLowerCase());
  const sourceTitles = getSourceTitleSet();
  const provenance = sourcesByPage(chosen.map((p) => p.page_id));
  const shared: string[] = [];
  const seen = new Set<string>(); // the same line on several pages is quoted once
  const bodies: string[] = [];

  const pages = chosen.map((hit): ResearchPage => {
    const body = displayPageBody(readPageMarkdown(hit.page_id) ?? '', hit.page_type);
    bodies.push(body.toLowerCase());
    const scan = scanCitations(body, (t) => sourceTitles.has(t.toLowerCase()));
    const sources = provenance.get(hit.page_id) ?? [];
    // A source page is one source's own text: its lines carry no citations,
    // so each quoted line is credited to that source.
    const sourcePage = SOURCE_PAGE_TYPES.has(hit.page_type) && sources.length === 1;
    // Links become their labels before clipping, so a clip never cuts one in half.
    const lines = keyLines(scan.markdown, terms, size.lines, seen, { cited: !sourcePage }).map((line) => {
      const numbered = placeholdersToSharedText(clipCited(stripWikilinks(line), MAX_LINE_CHARS), scan.order, shared);
      return sourcePage ? withMarker(numbered, sharedMarker(sources[0], shared)) : numbered;
    });
    return {
      page_id: hit.page_id,
      title: hit.title,
      page_type: hit.page_type,
      category: hit.category,
      summary: hit.summary === null ? null : stripWikilinks(hit.summary),
      last_updated: hit.last_updated,
      key_lines: lines,
      disputes: findPageDisputes(body).map((d) => d.topic),
      thin: SYNTHESIZED_PAGE_TYPES.has(hit.page_type) && sources.length === 1,
    };
  });

  // Names with no page that this topic touches: a word of the name starts
  // with a topic word, or the name appears as a whole word in the pack.
  const missing = runHealthChecksCached(getDb())
    .missing_cross_refs.filter((m) => {
      const name = m.entity_text.toLowerCase();
      const nameWords = name.split(/[^\p{L}\p{N}]+/u).filter(Boolean);
      if (terms.some((t) => nameWords.some((w) => w.startsWith(t)))) return true;
      const whole = new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(name)}(?![\\p{L}\\p{N}])`, 'u');
      return bodies.some((b) => whole.test(b));
    })
    .slice(0, MISSING_SHOWN)
    .map((m) => ({ name: m.entity_text, mentions: m.mention_count }));

  // After the key lines, so their numbers stay; a relation's other sources join the shared list.
  const connections = getRelationsAmong(chosen.map((p) => p.page_id), CONNECTIONS_SHOWN).map(
    (r): ResearchConnection => ({
      from: r.from,
      to: r.to,
      type: r.type,
      label: relationLabel(r.type, 'out'),
      source_count: r.source_ids.length,
      sources: r.source_ids.slice(0, SOURCES_PER_CONNECTION).map((id) => sharedNumber(id, shared)),
      sentence: r.sentence,
    })
  );

  return {
    topic,
    degraded,
    pages,
    sources: numberedSources(shared),
    missing_pages: missing,
    more_pages: items.slice(size.pages).map(({ page_id, title, page_type }) => ({ page_id, title, page_type })),
    connections,
  };
}

/**
 * The page's sentences that share the most topic words (prefix match, like
 * search), the earliest first on ties, returned in page order. With `cited`,
 * only sentences carrying a citation count. Headings, tables and code are
 * skipped; list markers are dropped; lines already in `seen` are skipped and
 * the chosen ones added.
 */
export function keyLines(
  markdown: string,
  terms: string[],
  count: number,
  seen: Set<string> = new Set(),
  options: { cited: boolean } = { cited: true }
): string[] {
  const candidates: Array<{ text: string; key: string; index: number; score: number }> = [];
  let inFence = false;
  for (const raw of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(raw)) {
      inFence = !inFence;
      continue;
    }
    const line = raw.trim();
    if (inFence || !line || line.startsWith('#') || line.startsWith('|')) continue;
    for (const sentence of citedSentences(line.replace(/^(?:[-*+]|\d+\.)\s+/, ''))) {
      if (options.cited && !hasCitationPlaceholder(sentence)) continue;
      const key = lineKey(sentence);
      if (!key || seen.has(key)) continue;
      const words = key.split(' ');
      const score = terms.filter((t) => words.some((w) => w.startsWith(t))).length;
      candidates.push({ text: sentence, key, index: candidates.length, score });
    }
  }
  const picked: typeof candidates = [];
  for (const c of [...candidates].sort((a, b) => b.score - a.score || a.index - b.index)) {
    if (picked.length === count) break;
    if (picked.some((p) => p.key === c.key)) continue;
    picked.push(c);
  }
  for (const p of picked) seen.add(p.key);
  return picked.sort((a, b) => a.index - b.index).map((c) => c.text);
}

/** Put a citation where page text has them: before the closing period ("…castle[1]."). */
function withMarker(line: string, marker: string): string {
  const end = /[.!?]$/.exec(line);
  return end ? `${line.slice(0, -1)}${marker}${end[0]}` : `${line}${marker}`;
}

/** A source's number in the shared list, adding it if new. */
function sharedNumber(sourceId: string, shared: string[]): number {
  const id = sourceId.toLowerCase();
  let i = shared.indexOf(id);
  if (i === -1) i = shared.push(id) - 1;
  return i + 1;
}

/** "[n]" for a source in the shared list, adding it if new. */
function sharedMarker(sourceId: string, shared: string[]): string {
  return `[${sharedNumber(sourceId, shared)}]`;
}

/** Distinct sources behind each page (provenance). */
function sourcesByPage(pageIds: string[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  if (!pageIds.length) return out;
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT page_id, source_id FROM provenance
        WHERE page_id IN (${pageIds.map(() => '?').join(', ')})`
    )
    .all(...pageIds) as Array<{ page_id: string; source_id: string }>;
  for (const row of rows) out.set(row.page_id, [...(out.get(row.page_id) ?? []), row.source_id]);
  return out;
}

function numberedSources(ids: string[]): ResearchSource[] {
  if (!ids.length) return [];
  const rows = getDb()
    .prepare(
      `SELECT source_id, title, source_url, date_ingested FROM sources
        WHERE lower(source_id) IN (${ids.map(() => '?').join(', ')})`
    )
    .all(...ids) as Array<{ source_id: string; title: string; source_url: string | null; date_ingested: string }>;
  const byId = new Map(rows.map((r) => [r.source_id.toLowerCase(), r]));
  return ids.map((id, i) => {
    const row = byId.get(id);
    return {
      n: i + 1,
      source_id: row?.source_id ?? id,
      title: row?.title ?? 'Source no longer in the wiki',
      source_url: row?.source_url ?? null,
      date_ingested: row?.date_ingested ?? null,
    };
  });
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
