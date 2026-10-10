/**
 * One page's history, for MCP recent_changes with a page_id: every compile
 * that fed it (source and date), page events from the activity log, and
 * which sections differ from the previous version. Plain reads.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';
import { getDb, getPage, readPageMarkdown, safePreviousContentPath } from './db';
import { displayPageBody, parseHeading } from './page-sections';
import type { Listed } from './wiki-changes';

export interface PageHistory {
  page: { page_id: string; title: string; page_type: string; created_at: string; last_updated: string };
  compiles: Listed<{ source_id: string; source_title: string | null; contribution_type: string; at: string }>;
  events: Listed<{ at: string; kind: string; detail: string | null }>;
  /** Null when the page has no stored previous version. */
  previous_version: { sections_added: string[]; sections_removed: string[]; sections_changed: string[] } | null;
}

/** Text before the first heading. */
const OPENING = '(opening)';

export function pageHistory(pageId: string, limit: number): PageHistory | null {
  const page = getPage(pageId);
  if (!page) return null;
  const db = getDb();

  const compiles = db
    .prepare(
      `SELECT pr.source_id, s.title AS source_title, pr.contribution_type, datetime(pr.date_compiled) AS at
         FROM provenance pr
         LEFT JOIN sources s ON s.source_id = pr.source_id
        WHERE pr.page_id = ?
        ORDER BY pr.date_compiled DESC, pr.id DESC
        LIMIT ?`
    )
    .all(pageId, limit) as PageHistory['compiles']['items'];
  const compileTotal = (db.prepare('SELECT COUNT(*) AS n FROM provenance WHERE page_id = ?').get(pageId) as { n: number }).n;

  // The activity log has no page column: instr() skips most rows cheaply
  // before json_extract confirms the match.
  const eventWhere = `instr(details, ?) > 0 AND json_extract(details, '$.page_id') = ?`;
  const events = (
    db
      .prepare(
        `SELECT datetime(timestamp) AS at, action_type AS kind, details
           FROM activity_log
          WHERE ${eventWhere}
          ORDER BY id DESC
          LIMIT ?`
      )
      .all(pageId, pageId, limit) as Array<{ at: string; kind: string; details: string | null }>
  ).map(({ at, kind, details }) => ({ at, kind, detail: eventDetail(details) }));
  const eventTotal = (
    db.prepare(`SELECT COUNT(*) AS n FROM activity_log WHERE ${eventWhere}`).get(pageId, pageId) as { n: number }
  ).n;

  return {
    page: {
      page_id: page.page_id,
      title: page.title,
      page_type: page.page_type,
      created_at: page.created_at,
      last_updated: page.last_updated,
    },
    compiles: { items: compiles, total: compileTotal },
    events: { items: events, total: eventTotal },
    previous_version: compareWithPrevious(pageId, page.previous_content_path, page.page_type),
  };
}

function compareWithPrevious(pageId: string, previousPath: string | null, pageType: string) {
  const safePath = safePreviousContentPath(pageId, previousPath);
  const current = readPageMarkdown(pageId);
  if (!safePath || !current || !fs.existsSync(safePath)) return null;
  let previous: string;
  try {
    previous = zlib.gunzipSync(fs.readFileSync(safePath)).toString('utf-8');
  } catch {
    return null;
  }
  const before = sections(displayPageBody(previous, pageType));
  const after = sections(displayPageBody(current, pageType));
  return {
    sections_added: [...after.keys()].filter((h) => !before.has(h)),
    sections_removed: [...before.keys()].filter((h) => !after.has(h)),
    sections_changed: [...after.keys()].filter((h) => before.has(h) && before.get(h) !== after.get(h)),
  };
}

/**
 * Body text by ## / ### heading. Citation tokens and spacing are left out of
 * the comparison: renumbered citations alone don't make a section "changed".
 * A heading used twice gets a number ("Notes (2)") so neither hides the other.
 */
export function sections(markdown: string): Map<string, string> {
  const out = new Map<string, string>();
  let heading = OPENING;
  let body: string[] = [];
  let inFence = false;
  const keep = () => {
    const text = body.join(' ').replace(/\[\^[^\]]+\]/g, '').replace(/\s+/g, ' ').trim();
    if (heading === OPENING && !text) return;
    let key = heading;
    for (let n = 2; out.has(key); n++) key = `${heading} (${n})`;
    out.set(key, text);
  };
  for (const line of markdown.split('\n')) {
    if (/^\s*(```|~~~)/.test(line)) inFence = !inFence;
    const parsed = !inFence && /^#{2,3}\s/.test(line) ? parseHeading(line) : null;
    if (parsed) {
      keep();
      heading = parsed.text;
      body = [];
    } else {
      body.push(line);
    }
  }
  keep();
  return out;
}

function eventDetail(raw: string | null): string | null {
  try {
    const d = JSON.parse(raw ?? '{}') as Record<string, unknown>;
    for (const key of ['topic', 'reason', 'error', 'message']) {
      if (typeof d[key] === 'string' && d[key]) return d[key] as string;
    }
  } catch {
    // Not JSON: no detail.
  }
  return null;
}
