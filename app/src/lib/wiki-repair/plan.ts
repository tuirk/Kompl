/**
 * What a wiki repair run would do, computed without changing anything: the
 * plan Settings shows before the owner confirms, and the dry run
 * (GET /api/wiki/repair/plan).
 *
 * The pages a run rebuilds depend on the AI's answers about the set-aside
 * name matches, so the plan gives a range:
 *   - low:  pages whose credited sources change whatever the AI answers
 *           (they change both if every match is confirmed and if none is),
 *           plus pages an earlier run left waiting;
 *   - high: every page that can change: those, the pages either extreme
 *           changes, and the pages a judged name could send a source to or
 *           take one from. A run rebuilds at most this many (its fixed
 *           bound); MAX_REPAIR_PAGES caps it.
 */

import type Database from 'better-sqlite3';

import { readPageMarkdown, readRawMarkdown } from '../db';
import { numericConflict } from '../name-guard';
import { mentionKey } from '../mention-pin';
import type { PageEstimateInput } from '../page-upgrade-estimate';
import { buildJudgePairs, judgeBatches, listAliasesToJudge, type SuspendedAlias } from './aliases';
import type { RepairEstimateInput } from './estimate';
import { repairLabels } from './labels';
import { MAX_REPAIR_ALIASES, MAX_REPAIR_PAGES } from './limits';
import {
  mergePendingPages,
  nocase,
  pageCreditChanges,
  readWikiExtractions,
  repairPin,
  topicPagesByKey,
  wikiMentionRows,
  type AliasPair,
} from './mentions';
import { readSavedRun, type PendingPage } from './state';

export interface PlannedPage {
  page_id: string;
  title: string;
  /** Changes whatever the AI answers (or is waiting from an earlier run). */
  certain: boolean;
  /** Sources it would lose / gain when no name match is confirmed (empty when unknown). */
  remove: string[];
  add: string[];
}

export interface RepairPlan {
  /** Name matches this run asks about, oldest first (at most MAX_REPAIR_ALIASES). */
  aliases: Array<{ id: number; alias: string; canonical: string }>;
  /** Set-aside matches left for a later run by the cap. */
  aliases_over_cap: number;
  /** Set-aside matches the AI could not decide before; not asked again. */
  aliases_undecided: number;
  name_check_calls: number;
  /** Sources whose mentions are credited again. */
  sources: number;
  /** Pages that can be rebuilt, the certain ones first (at most MAX_REPAIR_PAGES). */
  pages: PlannedPage[];
  pages_low: number;
  pages_high: number;
  pages_over_cap: number;
  /** Pages an earlier run left waiting (included above). */
  pages_waiting: number;
  labels: string[];
  /** The estimate's inputs (sizes), for lib/wiki-repair/estimate.ts. */
  estimate_input: RepairEstimateInput;
}

/** Active rows, plus `extra` rows treated as active, oldest first, without number clashes (as getAliases). */
function aliasSet(db: Database.Database, extra: SuspendedAlias[]): AliasPair[] {
  const active = db
    .prepare(
      `SELECT id, alias, canonical_name FROM aliases
        WHERE canonical_name IS NOT NULL AND COALESCE(status, 'active') = 'active'`
    )
    .all() as SuspendedAlias[];
  return [...active, ...extra]
    .sort((a, b) => a.id - b.id)
    .filter((r) => numericConflict(r.alias, r.canonical_name) === null)
    .map(({ alias, canonical_name }) => ({ alias, canonical_name }));
}

/** The pages a run may rebuild and the name matches it asks about. Reads only. */
export function computeRepairPlan(db: Database.Database): RepairPlan {
  const ext = readWikiExtractions(db);
  const waiting = readSavedRun()?.pending_pages ?? [];
  const allToJudge = listAliasesToJudge(db);
  const toJudge = allToJudge.slice(0, MAX_REPAIR_ALIASES);

  const none = aliasSet(db, []);
  const changesNone = pageCreditChanges(db, wikiMentionRows(db, ext, none));
  const changesAll = toJudge.length > 0 ? pageCreditChanges(db, wikiMentionRows(db, ext, aliasSet(db, toJudge))) : changesNone;

  // Pages a judged name can move a source to or from: its own page, the
  // page it set aside for, and the page it reaches without that match.
  const pinNone = repairPin(db, none);
  const pagesByKey = topicPagesByKey(db);
  const touched = new Map<string, { page_id: string; title: string }>();
  for (const r of toJudge) {
    if (!ext.namedBy.get(mentionKey(r.alias))?.size) continue;
    for (const name of [r.canonical_name, pinNone(r.alias)]) {
      for (const page of pagesByKey.get(nocase(name)) ?? []) touched.set(page.page_id, page);
    }
  }

  const noneIds = new Map(changesNone.map((p) => [p.page_id, p]));
  const allIds = new Set(changesAll.map((p) => p.page_id));
  const waitingNow = mergePendingPages(waiting, []);
  const planned = new Map<string, PlannedPage>();
  const add = (p: { page_id: string; title: string }, certain: boolean, change?: PendingPage) => {
    if (planned.has(p.page_id)) return;
    planned.set(p.page_id, { page_id: p.page_id, title: p.title, certain, remove: change?.remove ?? [], add: change?.add ?? [] });
  };
  for (const p of waitingNow) add(p, true, p);
  for (const p of changesNone) if (allIds.has(p.page_id)) add(p, true, p);
  for (const p of changesNone) add(p, false, p);
  for (const p of changesAll) add(p, false, p);
  for (const p of touched.values()) add(p, false, noneIds.get(p.page_id));

  const all = [...planned.values()].sort((a, b) => Number(b.certain) - Number(a.certain));
  const pages = all.slice(0, MAX_REPAIR_PAGES);
  const low = pages.filter((p) => p.certain);

  const pairs = buildJudgePairs(db, toJudge, ext);
  const labels = repairLabels();
  return {
    aliases: toJudge.map((r) => ({ id: r.id, alias: r.alias, canonical: r.canonical_name })),
    aliases_over_cap: allToJudge.length - toJudge.length,
    aliases_undecided: (db
      .prepare(`SELECT COUNT(*) AS n FROM aliases WHERE status = 'suspended'`)
      .get() as { n: number }).n - allToJudge.length,
    name_check_calls: judgeBatches(pairs).length,
    sources: ext.items.length,
    pages,
    pages_low: low.length,
    pages_high: pages.length,
    pages_over_cap: all.length - pages.length,
    pages_waiting: waitingNow.length,
    labels,
    estimate_input: {
      nameCheckBatches: judgeBatches(pairs).map((batch) =>
        batch.map((p) => p.entity_a.name.length + p.entity_a.context.length + p.entity_b.name.length + p.entity_b.context.length),
      ),
      pagesLow: pageSizes(db, low),
      pagesHigh: pageSizes(db, pages),
      labels: { count: labels.length, chars: labels.reduce((sum, l) => sum + l.length, 0) },
    },
  };
}

/** What rebuilding each page reads and writes: its sources after the change, and its text now. */
function pageSizes(db: Database.Database, pages: PlannedPage[]): PageEstimateInput[] {
  const credited = db.prepare('SELECT DISTINCT source_id FROM provenance WHERE page_id = ?');
  const rawChars = new Map<string, number>();
  const chars = (sourceId: string) => {
    if (!rawChars.has(sourceId)) {
      let n = 0;
      try {
        n = readRawMarkdown(sourceId)?.length ?? 0;
      } catch {
        n = 0;
      }
      rawChars.set(sourceId, n);
    }
    return rawChars.get(sourceId)!;
  };
  return pages.map((p) => {
    const removed = new Set(p.remove);
    const ids = new Set([
      ...(credited.all(p.page_id) as Array<{ source_id: string }>).map((r) => r.source_id).filter((id) => !removed.has(id)),
      ...p.add,
    ]);
    let pageChars = 0;
    try {
      pageChars = readPageMarkdown(p.page_id)?.length ?? 0;
    } catch {
      pageChars = 0;
    }
    return {
      source_chars: [...ids].reduce((sum, id) => sum + chars(id), 0),
      source_count: ids.size,
      page_chars: pageChars,
    };
  });
}
