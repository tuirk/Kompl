/**
 * Sources added by an AI agent (MCP add_source → POST /api/agent/sources).
 *
 * Adding sources starts a compile, which spends on the LLM, so this path is
 * off unless the user turns it on (Settings → Connect your AI) and is held
 * to MAX_PER_CALL items per call and MAX_PER_DAY per rolling day. Every
 * check runs before anything is staged; then the items go through the same
 * staging rows and finalize step as the app's own Add sources flow.
 */

import { randomUUID } from 'node:crypto';
import {
  deleteStagingBySession,
  findSourceByUrl,
  getAgentAddSourcesEnabled,
  getDb,
  getRunningCompileSession,
  insertCollectStaging,
  logActivity,
} from './db';
import { MAX_PER_CALL, MAX_PER_DAY } from './agent-sources-limits';
import { finalizeSession } from './finalize-session';
import { pageUpgradeBlock } from './page-upgrade-state';
import { isBlockedHost } from './url-blocklist';
import { urlKey, urlKeyCandidates } from './url-key';

const MAX_TEXT_CHARS = 100_000;
const MAX_URL_CHARS = 2_048;
const TITLE_MAX = 200;
const CLIENT_MAX = 80;

export interface AgentSourcesRequest {
  urls?: unknown;
  text?: unknown;
  title?: unknown;
  client?: unknown;
}

export interface AgentSourcesResult {
  status: number;
  body: Record<string, unknown>;
}

const fail = (status: number, error: string, message: string, extra: Record<string, unknown> = {}) => ({
  status,
  body: { error, message, ...extra },
});

export async function addAgentSources(req: AgentSourcesRequest): Promise<AgentSourcesResult> {
  if (!getAgentAddSourcesEnabled()) {
    return fail(
      403,
      'agent_sources_disabled',
      'Adding sources from AI agents is turned off. The user can turn it on in Kompl: Settings → Connect your AI.'
    );
  }

  const client = typeof req.client === 'string' && req.client.trim() ? req.client.trim().slice(0, CLIENT_MAX) : null;
  const items = parseItems(req, client);
  if ('error' in items) return fail(422, 'invalid_request', items.error);

  if (!items.staged.length) {
    return {
      status: 200,
      body: { session_id: null, added: 0, already_in_wiki: items.alreadyInWiki, blocked: items.blocked },
    };
  }

  // Nothing is staged while a compile or a page update runs: the new one
  // couldn't start, and staged rows would sit unseen. A compile left queued
  // that nothing will start doesn't count: finalizeSession supersedes it.
  const upgrading = pageUpgradeBlock();
  if (upgrading) return fail(409, 'page_upgrade_in_progress', upgrading.error);
  const running = getRunningCompileSession();
  if (running && !isLeftoverQueued(running.session_id)) return compileRunning(running);

  const usedToday = addedInLastDay();
  if (usedToday + items.staged.length > MAX_PER_DAY) {
    const left = Math.max(0, MAX_PER_DAY - usedToday);
    return fail(429, 'daily_limit', `AI agents can add ${MAX_PER_DAY} sources a day; ${left} left now.`, { left });
  }

  const session_id = randomUUID();
  getDb().transaction(() => {
    for (const s of items.staged) {
      insertCollectStaging({ stage_id: randomUUID(), session_id, connector: s.connector, payload: s.payload });
    }
  })();

  const result = await finalizeSession(session_id);
  if (result.status === 409 || result.status === 400) {
    // Lost a race with another compile: leave nothing behind.
    deleteStagingBySession(session_id);
    return { status: result.status, body: result.body };
  }
  logActivity('agent_sources_added', {
    source_id: null,
    details: { session_id, count: items.staged.length, client, labels: items.staged.map((s) => s.label) },
  });
  return {
    status: result.status,
    body: {
      ...result.body,
      session_id,
      added: items.staged.length,
      already_in_wiki: items.alreadyInWiki,
      blocked: items.blocked,
    },
  };
}

/** The refusal while a compile holds the gate: when it started, and to add after it. */
function compileRunning(active: { session_id: string; started_at: string | null }): AgentSourcesResult {
  const which = active.started_at
    ? `A compile is already running: session \`${active.session_id}\`, started ${active.started_at} UTC.`
    : `A compile is starting now: session \`${active.session_id}\`.`;
  return fail(
    409,
    'compile_running',
    `${which} Kompl runs one compile at a time and each add_source call starts one, so try again after it ` +
      'finishes (recent_changes with that session_id shows its progress).',
    { active_session_id: active.session_id, started_at: active.started_at }
  );
}

/** How long a queued compile may wait to start: the /api/health reconciler fails it after this. */
const QUEUED_LEFTOVER_MINUTES = 5;

/**
 * A compile queued but never started that nothing will start any more: the
 * last attempt to start it could not reach n8n (finalize and recompile log
 * compile_trigger_failed), or that attempt is older than the reconciler's
 * wait. It holds the gate until /api/health fails it; the app's own Add
 * sources supersedes it at once (finalizeSession), and so may an agent's
 * add. A compile whose start may still be on its way is not left over.
 */
function isLeftoverQueued(session_id: string): boolean {
  const ago = `-${QUEUED_LEFTOVER_MINUTES} minutes`;
  const row = getDb()
    .prepare(
      `SELECT status, started_at, datetime(created_at) < datetime('now', ?) AS old
         FROM compile_progress WHERE session_id = ?`
    )
    .get(ago, session_id) as { status: string; started_at: string | null; old: number } | undefined;
  if (!row || row.status !== 'queued' || row.started_at !== null) return false;
  // The newest attempt to start the session, or its failure. A recompile
  // logs both by source; finalize logs both with the session id.
  const last = getDb()
    .prepare(
      `SELECT action_type, datetime(timestamp) < datetime('now', ?) AS old
         FROM activity_log
        WHERE action_type IN ('onboarding_confirmed', 'source_recompile_triggered', 'compile_trigger_failed')
          AND (CASE WHEN json_valid(details) THEN json_extract(details, '$.session_id') END = ?
               OR source_id IN (SELECT source_id FROM sources WHERE onboarding_session_id = ?))
        ORDER BY id DESC
        LIMIT 1`
    )
    .get(ago, session_id, session_id) as { action_type: string; old: number } | undefined;
  if (!last) return row.old === 1;
  return last.action_type === 'compile_trigger_failed' || last.old === 1;
}

interface StagedItem {
  connector: 'url' | 'paste';
  payload: Record<string, unknown>;
  label: string;
}

/** Validate the request into staging payloads; links already in the wiki or on the blocklist are set aside. */
function parseItems(
  req: AgentSourcesRequest,
  client: string | null
): { staged: StagedItem[]; alreadyInWiki: Array<{ url: string; source_id: string }>; blocked: string[] } | { error: string } {
  const provenance = { added_via: 'mcp', ...(client ? { client } : {}) };
  const hasUrls = req.urls !== undefined;
  const hasText = req.text !== undefined;
  if (!hasUrls && !hasText) return { error: 'Give urls (links to add) or text (a note to keep).' };
  if (hasUrls && hasText) return { error: 'Give either urls or text, not both.' };

  if (hasText) {
    if (typeof req.text !== 'string' || !req.text.trim()) return { error: 'text must be non-empty.' };
    if (req.text.length > MAX_TEXT_CHARS) return { error: `text is longer than ${MAX_TEXT_CHARS} characters.` };
    const given = typeof req.title === 'string' ? req.title.trim() : '';
    const title = (given || firstLine(req.text) || `Note from ${client ?? 'an AI agent'}`).slice(0, TITLE_MAX);
    return {
      staged: [{ connector: 'paste', payload: { title, text: req.text, source_url: null, metadata: provenance }, label: title }],
      alreadyInWiki: [],
      blocked: [],
    };
  }

  if (!Array.isArray(req.urls) || !req.urls.length) return { error: 'urls must be a non-empty list.' };
  if (req.urls.length > MAX_PER_CALL) return { error: `At most ${MAX_PER_CALL} links per call.` };
  const staged: StagedItem[] = [];
  const alreadyInWiki: Array<{ url: string; source_id: string }> = [];
  const blocked: string[] = [];
  // The same page written differently ("EX.org/a", " ex.org/a/ ") is one link:
  // each copy would otherwise be fetched and compiled.
  const seen = new Set<string>();
  for (const raw of req.urls) {
    const url = typeof raw === 'string' ? raw.trim() : '';
    if (url.length > MAX_URL_CHARS) return { error: `Links can be at most ${MAX_URL_CHARS} characters.` };
    if (!isHttpUrl(url)) return { error: `Not an http(s) link: ${String(raw).slice(0, 200)}` };
    const key = urlKey(url)!;
    if (seen.has(key)) continue;
    seen.add(key);
    if (isBlockedHost(url)) {
      blocked.push(url);
      continue;
    }
    const existing = findSourceByUrl(url) ?? findSavedLink(key);
    if (existing) {
      alreadyInWiki.push({ url, source_id: existing.source_id });
      continue;
    }
    staged.push({ connector: 'url', payload: { url, metadata_hint: provenance }, label: url });
  }
  return { staged, alreadyInWiki, blocked };
}

/**
 * A source saved from the same page however it was written: host case or a
 * trailing slash. The lower-cased pass finds the candidates; urlKey decides,
 * so a path differing only in case is not taken for the same page.
 */
function findSavedLink(key: string): { source_id: string } | null {
  const candidates = urlKeyCandidates(key);
  const rows = getDb()
    .prepare(
      `SELECT source_id, source_url FROM sources
        WHERE lower(source_url) IN (${candidates.map(() => '?').join(', ')})
          AND compile_status != 'collected'`
    )
    .all(...candidates) as Array<{ source_id: string; source_url: string }>;
  const match = rows.find((r) => urlKey(r.source_url) === key);
  return match ? { source_id: match.source_id } : null;
}

/** Items agents added in the last 24 hours, from their activity rows. */
function addedInLastDay(): number {
  const row = getDb()
    .prepare(
      `SELECT COALESCE(SUM(json_extract(details, '$.count')), 0) AS n
         FROM activity_log
        WHERE action_type = 'agent_sources_added'
          AND datetime(timestamp) >= datetime('now', '-1 day')`
    )
    .get() as { n: number };
  return row.n;
}

function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value);
    return protocol === 'http:' || protocol === 'https:';
  } catch {
    return false;
  }
}

function firstLine(text: string): string {
  return (text.trim().split('\n')[0] ?? '').replace(/^#+\s*/, '').trim().slice(0, 80);
}
