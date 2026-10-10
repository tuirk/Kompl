/**
 * What changed in the wiki, for MCP recent_changes (GET /api/wiki/changes):
 * since a time, or in one compile session. Plain reads.
 *
 * Pages are credited to the sources that changed them through provenance
 * (one row per compile per source), not the activity log, whose
 * page_compiled rows name only the first source.
 */

import { getAllArchivedPageIds, getCompileProgress, getDb } from './db';

const SAVED_LINKS_PAGE_ID = 'saved-links';
/** Sources listed per changed page; the rest are counted. */
const SOURCES_PER_PAGE = 10;

export interface Listed<T> {
  items: T[];
  /** All matches, before the limit. */
  total: number;
}

export interface PageChange {
  page_id: string;
  title: string;
  page_type: string;
  change: 'created' | 'updated';
  at: string;
  /** The first SOURCES_PER_PAGE sources behind the change… */
  sources: Array<{ source_id: string; title: string | null }>;
  /** …out of this many. */
  source_total: number;
}

export interface SourceAdded {
  source_id: string;
  title: string;
  source_type: string;
  source_url: string | null;
  date_ingested: string;
  page_count: number;
  /** The compile session that added it: recent_changes(session_id) shows what it changed. */
  onboarding_session_id: string | null;
}

export interface WikiEvent {
  at: string;
  kind: string;
  page_id: string | null;
  page_title: string | null;
  source_title: string | null;
  detail: string | null;
}

export interface ChangesSince {
  since: string;
  sources_added: Listed<SourceAdded>;
  pages: Listed<PageChange>;
  disputes: Listed<WikiEvent>;
  failures: Listed<WikiEvent>;
}

/** `since` is any SQLite datetime() input; the caller validated it. */
export function changesSince(since: string, limit: number): ChangesSince {
  const db = getDb();
  const sources = db
    .prepare(
      `SELECT s.source_id, s.title, s.source_type, s.source_url, s.date_ingested, s.onboarding_session_id,
              (SELECT COUNT(DISTINCT pr.page_id) FROM provenance pr WHERE pr.source_id = s.source_id) AS page_count
         FROM sources s
        WHERE datetime(s.date_ingested) >= datetime(?)
        ORDER BY s.date_ingested DESC`
    )
    .all(since) as SourceAdded[];

  const provenance = db
    .prepare(
      `SELECT pr.page_id, pr.source_id, s.title AS source_title, datetime(pr.date_compiled) AS at
         FROM provenance pr
         LEFT JOIN sources s ON s.source_id = pr.source_id
        WHERE datetime(pr.date_compiled) >= datetime(?)`
    )
    .all(since) as Array<{ page_id: string; source_id: string; source_title: string | null; at: string }>;
  // Rewrites without a new source (redraft, restore, upgrade) only touch last_updated.
  const touched = db
    .prepare(`SELECT page_id, datetime(last_updated) AS at FROM pages WHERE datetime(last_updated) >= datetime(?)`)
    .all(since) as Array<{ page_id: string; at: string }>;

  return {
    since,
    sources_added: listed(sources, limit),
    pages: listed(pageChanges(since, [...provenance, ...touched]), limit),
    disputes: listed(events(`a.action_type = 'page_dispute_recorded'`, since), limit),
    failures: listed(events(`a.action_type LIKE '%\\_failed' ESCAPE '\\'`, since), limit),
  };
}

export interface SessionChanges {
  session_id: string;
  status: string | null;
  current_step: string | null;
  error: string | null;
  started_at: string | null;
  completed_at: string | null;
  staged: Listed<{ item: string; status: string; error: string | null }>;
  sources_added: Listed<SourceAdded>;
  pages: Listed<PageChange>;
  failures: Listed<WikiEvent>;
}

/** One compile session: progress, each staged item's fate, and what it changed. Null if unknown. */
export function changesForSession(sessionId: string, limit: number): SessionChanges | null {
  const db = getDb();
  const progress = getCompileProgress(sessionId);
  const staged = db
    .prepare(`SELECT payload, status, error_message FROM collect_staging WHERE session_id = ? ORDER BY created_at, stage_id`)
    .all(sessionId) as Array<{ payload: string; status: string; error_message: string | null }>;
  const sources = db
    .prepare(
      `SELECT s.source_id, s.title, s.source_type, s.source_url, s.date_ingested, s.onboarding_session_id,
              (SELECT COUNT(DISTINCT pr.page_id) FROM provenance pr WHERE pr.source_id = s.source_id) AS page_count
         FROM sources s
        WHERE s.onboarding_session_id = ?
        ORDER BY s.date_ingested`
    )
    .all(sessionId) as SourceAdded[];
  if (!progress && !staged.length && !sources.length) return null;

  const ids = sources.map((s) => s.source_id);
  const provenance = ids.length
    ? (db
        .prepare(
          `SELECT pr.page_id, pr.source_id, s.title AS source_title, datetime(pr.date_compiled) AS at
             FROM provenance pr
             LEFT JOIN sources s ON s.source_id = pr.source_id
            WHERE pr.source_id IN (${ids.map(() => '?').join(', ')})`
        )
        .all(...ids) as Array<{ page_id: string; source_id: string; source_title: string | null; at: string }>)
    : [];
  // created_at, not started_at: a retry restarts started_at, and pages from
  // the first run would then read as "updated".
  const since = progress?.created_at ?? progress?.started_at ?? sources[0]?.date_ingested ?? '1970-01-01';

  return {
    session_id: sessionId,
    status: progress?.status ?? null,
    current_step: progress?.current_step ?? null,
    error: progress?.error ?? null,
    started_at: progress?.started_at ?? null,
    completed_at: progress?.completed_at ?? null,
    staged: listed(
      staged.map((row) => ({ item: stagedLabel(row.payload), status: row.status, error: row.error_message })),
      limit
    ),
    sources_added: listed(sources, limit),
    pages: listed(pageChanges(since, provenance), limit),
    // Compile-level failures (n8n, the trigger, the stuck-queue reconciler)
    // carry the session only in their details.
    failures: listed(
      events(
        `(a.session_id = ? OR (a.session_id IS NULL AND json_extract(a.details, '$.session_id') = ?))
          AND a.action_type LIKE '%\\_failed' ESCAPE '\\'`,
        null,
        [sessionId, sessionId]
      ),
      limit
    ),
  };
}

function pageChanges(
  since: string,
  rows: Array<{ page_id: string; at: string; source_id?: string; source_title?: string | null }>
): PageChange[] {
  const archived = getAllArchivedPageIds();
  const byPage = new Map<string, { at: string; sources: Map<string, string | null> }>();
  for (const row of rows) {
    if (row.page_id === SAVED_LINKS_PAGE_ID || archived.has(row.page_id)) continue;
    const entry = byPage.get(row.page_id) ?? { at: row.at, sources: new Map() };
    if (row.at > entry.at) entry.at = row.at;
    if (row.source_id) entry.sources.set(row.source_id, row.source_title ?? null);
    byPage.set(row.page_id, entry);
  }
  if (!byPage.size) return [];
  const ids = [...byPage.keys()];
  const pages = getDb()
    .prepare(
      `SELECT page_id, title, page_type, datetime(created_at) >= datetime(?) AS created
         FROM pages
        WHERE page_id IN (${ids.map(() => '?').join(', ')}) AND page_type != 'archived'`
    )
    .all(since, ...ids) as Array<{ page_id: string; title: string; page_type: string; created: number }>;
  return pages
    .map((p) => {
      const entry = byPage.get(p.page_id)!;
      return {
        page_id: p.page_id,
        title: p.title,
        page_type: p.page_type,
        change: p.created ? ('created' as const) : ('updated' as const),
        at: entry.at,
        sources: [...entry.sources]
          .slice(0, SOURCES_PER_PAGE)
          .map(([source_id, title]) => ({ source_id, title })),
        source_total: entry.sources.size,
      };
    })
    .sort((a, b) => (a.at < b.at ? 1 : a.at > b.at ? -1 : a.title.localeCompare(b.title)));
}

/** Activity rows matching `where` (on alias a), newest first. */
function events(where: string, since: string | null, params: unknown[] = []): WikiEvent[] {
  const rows = getDb()
    .prepare(
      `SELECT datetime(a.timestamp) AS timestamp, a.action_type, a.details, s.title AS source_title
         FROM activity_log a
         LEFT JOIN sources s ON s.source_id = a.source_id
        WHERE ${where} ${since === null ? '' : 'AND datetime(a.timestamp) >= datetime(?)'}
        ORDER BY a.id DESC`
    )
    .all(...params, ...(since === null ? [] : [since])) as Array<{
    timestamp: string;
    action_type: string;
    details: string | null;
    source_title: string | null;
  }>;
  return rows.map((row) => {
    const d = parseDetails(row.details);
    return {
      at: row.timestamp,
      kind: row.action_type,
      page_id: str(d.page_id),
      page_title: str(d.title),
      source_title: row.source_title ?? str(d.source_title),
      detail: str(d.topic) ?? str(d.error) ?? str(d.message) ?? str(d.url) ?? str(d.source_url),
    };
  });
}

function listed<T>(items: T[], limit: number): Listed<T> {
  return { items: items.slice(0, limit), total: items.length };
}

function parseDetails(raw: string | null): Record<string, unknown> {
  try {
    const value: unknown = JSON.parse(raw ?? '{}');
    return value && typeof value === 'object' ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

function str(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}

/** A staged item's address or title, for "which link failed?". */
function stagedLabel(payload: string): string {
  const p = parseDetails(payload);
  return str(p.url) ?? str(p.source_url) ?? str(p.title) ?? str(p.title_hint) ?? 'text';
}
