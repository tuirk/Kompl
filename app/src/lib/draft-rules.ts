/**
 * Which writing rules a page's text was drafted under (schema v27).
 *
 * The rules (lib/writing-rules.ts) change between releases; v0.4 was the
 * first to record them. A compile only adds to an existing page, so a page
 * keeps the text it was first written with until it is written again from
 * scratch. The marker says which rules that text follows:
 *
 *   pages.draft_rules       the rules version the text was written from
 *                           scratch under: by a compile plan drafted from
 *                           scratch, an update from Settings > Wiki health
 *                           (lib/redraft.ts), or a recompile after a source
 *                           delete (lib/recompile.ts). NULL = written before
 *                           v0.4. Update-mode compile drafts keep the existing
 *                           text, so they leave the marker as it is. So does
 *                           "Restore this version": the user chose that text,
 *                           and a bulk update never rewrites it.
 *   page_plans.draft_rules  the rules a compile draft was made under, set by
 *                           the draft step on every LLM draft and copied to
 *                           the page when a plan drafted from scratch commits.
 *                           A draft made under older rules (for example, one
 *                           still waiting for approval) keeps its own marker,
 *                           so approving it later never marks old text as
 *                           current.
 *
 * A page whose marker is not CURRENT_DRAFT_RULES (NULL included) is offered
 * for an update, so a release with new rules needs no change here.
 * Original-source pages (the user's own text) and the Saved Links page are
 * never marked and never offered.
 *
 * The write helpers run inside the caller's Phase 2 transaction (CLAUDE.md
 * rule 5): synchronous, no await, no file I/O.
 */

import type Database from 'better-sqlite3';

import { getDb, getSetting, setSetting } from './db';
import { DRAFT_TYPE_SQL, HELD_PAGE_SQL } from './page-hold';
import { CURRENT_DRAFT_RULES } from './writing-rules';

export { CURRENT_DRAFT_RULES } from './writing-rules';

/** Page types the LLM writes from sources. Original-source pages hold the user's own text. */
export const DRAFTED_PAGE_TYPES: ReadonlySet<string> = new Set([
  'source-summary',
  'entity',
  'concept',
  'comparison',
  'overview',
]);

/** Pages the app writes itself; never drafted, updated or restored. */
export const APP_PAGE_IDS: ReadonlySet<string> = new Set(['saved-links']);

/** A page whose text the LLM drafts from its sources (the only pages that carry a marker). */
export function isDraftedPage(page: { page_id: string; page_type: string }): boolean {
  return DRAFTED_PAGE_TYPES.has(page.page_type) && !APP_PAGE_IDS.has(page.page_id);
}

/**
 * Did this plan's draft start from scratch? Mirrors the page_id choice in the
 * commit paths: only an 'update' plan with an existing page keeps that
 * page's text; every other content plan writes a new page.
 */
export function planDraftsFromScratch(plan: { action: string; existing_page_id: string | null }): boolean {
  if (plan.action === 'provenance-only') return false;
  return !(plan.action === 'update' && plan.existing_page_id);
}

/** Set a page's marker. Phase 2 only (inside the commit transaction). */
export function setPageDraftRules(db: Database.Database, pageId: string, rules: string | null): void {
  db.prepare('UPDATE pages SET draft_rules = ? WHERE page_id = ?').run(rules, pageId);
}

/**
 * Copy a committed plan's marker to its page. Phase 2 only. Callers pass
 * plans that drafted from scratch; a draft made under older rules copies
 * its own marker (NULL before v0.4), so the page stays offered.
 */
export function copyPlanDraftRules(db: Database.Database, planId: string, pageId: string): void {
  db.prepare(
    'UPDATE pages SET draft_rules = (SELECT draft_rules FROM page_plans WHERE plan_id = ?) WHERE page_id = ?',
  ).run(planId, pageId);
}

/**
 * Marker from an untrusted backup row: a version label such as 'v0.4' is
 * kept, anything else (including a missing field in older backups) imports
 * as NULL, which only means "offer this page for an update".
 */
export function sanitizeDraftRules(value: unknown): string | null {
  return typeof value === 'string' && /^v\d+(\.\d+){0,3}$/.test(value) ? value : null;
}

/** page_id → draft_rules for every page, for the .kompl backup. */
export function getPageDraftRulesMap(): Map<string, string | null> {
  const rows = getDb().prepare('SELECT page_id, draft_rules FROM pages').all() as Array<{
    page_id: string;
    draft_rules: string | null;
  }>;
  return new Map(rows.map((r) => [r.page_id, r.draft_rules]));
}

// ── Pages to update ────────────────────────────────────────────────────────

const TYPE_LIST = [...DRAFTED_PAGE_TYPES];
const APP_LIST = [...APP_PAGE_IDS];

/**
 * A page an update could rebuild: an LLM-drafted type, not an app page, and
 * at least one active source (a page whose sources are all archived is
 * hidden from the wiki and has nothing to rebuild from). A page archived
 * after a failed rewrite counts with the type it returns as
 * (lib/page-hold.ts). Followed by a condition on p.draft_rules, compared
 * with CURRENT_DRAFT_RULES.
 */
const DRAFTED_PAGE_WHERE = `
      ${DRAFT_TYPE_SQL} IN (${TYPE_LIST.map(() => '?').join(', ')})
  AND p.page_id NOT IN (${APP_LIST.map(() => '?').join(', ')})
  AND EXISTS (
        SELECT 1
          FROM provenance pr
          JOIN sources s ON s.source_id = pr.source_id
         WHERE pr.page_id = p.page_id
           AND s.status = 'active'
      )`;
/**
 * ...written under other rules (NULL included), or archived after a failed
 * rewrite, whose text may still carry a deleted source: offered for an update.
 */
const CANDIDATE_WHERE = `${DRAFTED_PAGE_WHERE}
  AND (p.draft_rules IS NULL OR p.draft_rules <> ? OR ${HELD_PAGE_SQL})`;
/** ...written under the current rules, and live. */
const CURRENT_WHERE = `${DRAFTED_PAGE_WHERE}
  AND p.draft_rules = ? AND NOT ${HELD_PAGE_SQL}`;
const CANDIDATE_PARAMS = [...TYPE_LIST, ...APP_LIST, CURRENT_DRAFT_RULES];

export interface UpgradeCandidate {
  page_id: string;
  title: string;
  page_type: string;
  created_at: string;
  last_updated: string;
}

/** Pages written under other rules that an update could rebuild, oldest first, set-aside ones included. */
function listOutdatedPages(): UpgradeCandidate[] {
  return getDb()
    .prepare(
      `SELECT p.page_id, p.title, ${DRAFT_TYPE_SQL} AS page_type, p.created_at, p.last_updated
         FROM pages p
        WHERE ${CANDIDATE_WHERE}
        ORDER BY p.created_at ASC, p.page_id ASC`,
    )
    .all(...CANDIDATE_PARAMS) as UpgradeCandidate[];
}

/** Pages to update, oldest first (the order a run processes them in). Set-aside pages are left out. */
export function listUpgradeCandidates(): UpgradeCandidate[] {
  const setAside = readSetAside();
  return listOutdatedPages().filter((p) => !stillSetAside(setAside[p.page_id], p.last_updated));
}

export function countUpgradeCandidates(): number {
  return listUpgradeCandidates().length;
}

/** Pages Kompl drafts that already follow the current rules (the card's "up to date" count). */
export function countCurrentPages(): number {
  return (
    getDb()
      .prepare(`SELECT COUNT(*) AS n FROM pages p WHERE ${CURRENT_WHERE}`)
      .get(...CANDIDATE_PARAMS) as { n: number }
  ).n;
}

/** Is this page still waiting for an update? (A run re-checks before each page.) */
export function isUpgradeCandidate(pageId: string): boolean {
  const row = getDb()
    .prepare(`SELECT p.last_updated FROM pages p WHERE p.page_id = ? AND ${CANDIDATE_WHERE}`)
    .get(pageId, ...CANDIDATE_PARAMS) as { last_updated: string } | undefined;
  return Boolean(row) && !stillSetAside(readSetAside()[pageId], row!.last_updated);
}

// ── Pages set aside ────────────────────────────────────────────────────────

/**
 * Settings row: pages an update could not rebuild, as JSON
 * { [page_id]: SetAsideEntry }. Such a page keeps its text and is neither
 * offered nor charged again until it changes (a compile, recompile or
 * restore moves its last_updated) or a new version brings new rules. No
 * schema change: the row travels in backups with the pages it describes.
 */
export const PAGE_UPGRADE_SET_ASIDE = 'page_upgrade_set_aside';

/**
 * Update refusals that mean the page can't be rebuilt from its sources as
 * they are. Other refusals (the page changed or was busy) are retried by the
 * next run.
 */
export const SET_ASIDE_REASONS: ReadonlySet<string> = new Set(['draft_too_thin', 'no_readable_sources']);

interface SetAsideEntry {
  /** The rules the update tried to apply. */
  rules: string;
  /** pages.last_updated when the page was set aside. */
  last_updated: string;
  /** RedraftError code (one of SET_ASIDE_REASONS). */
  reason: string;
}

export interface SetAsidePage {
  page_id: string;
  title: string;
  reason: string;
}

/** The row may come from a backup: anything malformed reads as "nothing set aside". */
function readSetAside(): Record<string, SetAsideEntry> {
  const raw = getSetting(PAGE_UPGRADE_SET_ASIDE);
  if (!raw) return {};
  try {
    const parsed: unknown = JSON.parse(raw);
    return parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, SetAsideEntry>)
      : {};
  } catch {
    return {};
  }
}

function stillSetAside(entry: SetAsideEntry | undefined, lastUpdated: string): boolean {
  return (
    typeof entry === 'object' &&
    entry !== null &&
    entry.rules === CURRENT_DRAFT_RULES &&
    entry.last_updated === lastUpdated
  );
}

/**
 * Remember that an update could not rebuild this page as it is now. Entries
 * that no longer apply (the page changed or is gone) are dropped on the way,
 * so the row only ever lists pages that are currently set aside.
 */
export function setPageAside(page: { page_id: string; last_updated: string }, reason: string): void {
  const current = readSetAside();
  const lastUpdated = new Map(
    (getDb().prepare('SELECT page_id, last_updated FROM pages').all() as Array<{ page_id: string; last_updated: string }>).map(
      (r) => [r.page_id, r.last_updated],
    ),
  );
  const next: Record<string, SetAsideEntry> = {};
  for (const [pageId, entry] of Object.entries(current)) {
    const stamp = lastUpdated.get(pageId);
    if (stamp !== undefined && stillSetAside(entry, stamp)) next[pageId] = entry;
  }
  next[page.page_id] = { rules: CURRENT_DRAFT_RULES, last_updated: page.last_updated, reason };
  setSetting(PAGE_UPGRADE_SET_ASIDE, JSON.stringify(next));
}

/** Pages written under other rules that an update could not rebuild, oldest first. */
export function listSetAsidePages(): SetAsidePage[] {
  const setAside = readSetAside();
  return listOutdatedPages()
    .filter((p) => stillSetAside(setAside[p.page_id], p.last_updated))
    .map((p) => ({ page_id: p.page_id, title: p.title, reason: setAside[p.page_id].reason }));
}

/** page_id → its active source ids, for every page waiting for an update. */
export function getCandidateSourceIds(): Map<string, string[]> {
  const rows = getDb()
    .prepare(
      `SELECT DISTINCT pr.page_id, pr.source_id
         FROM provenance pr
         JOIN sources s ON s.source_id = pr.source_id AND s.status = 'active'
         JOIN pages p ON p.page_id = pr.page_id
        WHERE ${CANDIDATE_WHERE}`,
    )
    .all(...CANDIDATE_PARAMS) as Array<{ page_id: string; source_id: string }>;
  const byPage = new Map<string, string[]>();
  for (const r of rows) {
    const list = byPage.get(r.page_id) ?? [];
    list.push(r.source_id);
    byPage.set(r.page_id, list);
  }
  return byPage;
}
