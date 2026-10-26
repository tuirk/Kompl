/**
 * Step 2 of the wiki repair (owner decision D2): the name matches the alias
 * screen set aside (aliases.status = 'suspended', lib/alias-screen.ts) are
 * judged by the AI with the resolver's own Layer 3 call (nlp-service
 * /resolve/disambiguate), REPAIR_ALIAS_BATCH at a time:
 *   same       → used again (status 'active'); method records that the
 *                repair confirmed it
 *   different  → retired, with the AI's reason; never used or re-added
 *   ambiguous  → stays set aside, marked so later runs do not pay to ask
 *                again; a batch that failed or got no answer is not marked
 *                and is asked again by the next run
 * Retired rows, the owner's included, are never touched: only suspended
 * rows are read and every write re-checks the status.
 *
 * Each side goes with the context Layer 3 normally gets: the name's type and
 * context from an extraction that lists it, else the summary of the page of
 * that title.
 */

import type Database from 'better-sqlite3';

import { computeDisambiguateMs } from '../compile-timeouts';
import { mentionKey } from '../mention-pin';
import { postNlp } from './calls';
import { REPAIR_ALIAS_BATCH } from './limits';
import { nocase, type WikiExtractions } from './mentions';

/** aliases.method of a row the repair confirmed. */
export const REPAIR_CONFIRMED_METHOD = 'repair_confirmed';
/** aliases.status_reason of a set-aside row the AI could not decide. */
export const REPAIR_UNDECIDED_REASON = 'repair_undecided';

/** Reasons nlp-service gives an 'ambiguous' answer that was never a verdict. */
const NOT_A_VERDICT = /^(llm_failed|no_verdict|cap_exceeded):/;

export interface SuspendedAlias {
  id: number;
  alias: string;
  canonical_name: string;
}

/** Set-aside rows the AI has not been asked about yet, oldest first. */
export function listAliasesToJudge(db: Database.Database): SuspendedAlias[] {
  return db
    .prepare(
      `SELECT id, alias, canonical_name FROM aliases
        WHERE status = 'suspended' AND canonical_name IS NOT NULL
          AND COALESCE(status_reason, '') != ?
        ORDER BY id`
    )
    .all(REPAIR_UNDECIDED_REASON) as SuspendedAlias[];
}

interface Side {
  name: string;
  type: string;
  source_id: string;
  context: string;
}

export interface JudgePair {
  pair_id: string;
  entity_a: Side;
  entity_b: Side;
  /** Not read by Layer 3's prompt; the request model requires it. */
  similarity: number;
  same_source: boolean;
  /** 'concept' when either side is a concept: Layer 3 uses its concept prompt then. */
  kind: 'entity' | 'concept';
}

const text = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

function nameFacts(ext: WikiExtractions): Map<string, { type: string; context: string; source_id: string }> {
  const facts = new Map<string, { type: string; context: string; source_id: string }>();
  const add = (name: string, fact: { type: string; context: string; source_id: string }) => {
    const key = mentionKey(name);
    const known = facts.get(key);
    if (!known || (!known.context && fact.context)) facts.set(key, fact);
  };
  for (const { source_id, llm } of ext.items) {
    for (const e of Array.isArray(llm.entities) ? llm.entities : []) {
      const o = (e ?? {}) as Record<string, unknown>;
      if (text(o.name)) add(text(o.name), { type: text(o.type) || 'OTHER', context: text(o.context), source_id });
    }
    for (const c of Array.isArray(llm.concepts) ? llm.concepts : []) {
      const o = (c ?? {}) as Record<string, unknown>;
      if (text(o.name)) add(text(o.name), { type: 'CONCEPT', context: text(o.description), source_id });
    }
  }
  return facts;
}

/** The pairs to send, entity pairs first, in row order (pair_id is the alias row id). */
export function buildJudgePairs(db: Database.Database, rows: SuspendedAlias[], ext: WikiExtractions): JudgePair[] {
  const facts = nameFacts(ext);
  const pages = new Map<string, { page_type: string; summary: string | null }>();
  for (const p of db
    .prepare(`SELECT title, page_type, summary FROM pages WHERE page_type IN ('entity', 'concept') ORDER BY created_at`)
    .all() as Array<{ title: string; page_type: string; summary: string | null }>) {
    if (!pages.has(nocase(p.title))) pages.set(nocase(p.title), p);
  }
  const side = (name: string): Side => {
    const fact = facts.get(mentionKey(name));
    const page = pages.get(nocase(name));
    const pageType = page ? (page.page_type === 'concept' ? 'CONCEPT' : 'OTHER') : 'OTHER';
    return {
      name,
      type: fact?.type ?? pageType,
      source_id: fact?.source_id ?? 'wiki',
      context: fact?.context || page?.summary?.trim() || '',
    };
  };
  const pairs = rows.map((r): JudgePair => {
    const a = side(r.alias);
    const b = side(r.canonical_name);
    const byA = ext.namedBy.get(mentionKey(r.alias));
    const byB = ext.namedBy.get(mentionKey(r.canonical_name));
    return {
      pair_id: String(r.id),
      entity_a: a,
      entity_b: b,
      similarity: 0,
      same_source: Boolean(byA && byB && [...byA].some((s) => byB.has(s))),
      kind: a.type === 'CONCEPT' || b.type === 'CONCEPT' ? 'concept' : 'entity',
    };
  });
  return [...pairs.filter((p) => p.kind === 'entity'), ...pairs.filter((p) => p.kind === 'concept')];
}

/** Batches of one kind each, so every batch is one AI call. */
export function judgeBatches(pairs: JudgePair[]): JudgePair[][] {
  const batches: JudgePair[][] = [];
  for (const kind of ['entity', 'concept'] as const) {
    const ofKind = pairs.filter((p) => p.kind === kind);
    for (let i = 0; i < ofKind.length; i += REPAIR_ALIAS_BATCH) batches.push(ofKind.slice(i, i + REPAIR_ALIAS_BATCH));
  }
  return batches;
}

export interface AliasVerdict {
  pair_id: string | null;
  decision: string;
  reason: string;
}

/** One batch through Layer 3; throws RepairCallError on the ceiling, a rate limit or a failed call. */
export async function judgeBatch(batch: JudgePair[], model: string): Promise<AliasVerdict[]> {
  const body = {
    pairs: batch.map(({ kind: _kind, ...pair }) => pair),
    compile_model: model,
  };
  const res = await postNlp<{ results: AliasVerdict[] }>('/resolve/disambiguate', body, computeDisambiguateMs(batch.length));
  return res.results;
}

export interface VerdictCounts {
  confirmed: number;
  retired: number;
  undecided: number;
  /** No verdict (failed batch, missing answer): asked again next run. */
  unanswered: number;
}

/** Applies one batch's verdicts in one transaction. Only rows still suspended change. */
export function applyAliasVerdicts(db: Database.Database, batch: JudgePair[], verdicts: AliasVerdict[]): VerdictCounts {
  const byId = new Map(verdicts.filter((v) => v.pair_id !== null).map((v) => [v.pair_id as string, v]));
  const confirm = db.prepare(
    `UPDATE aliases SET status = 'active', method = ?, status_reason = 'confirmed', status_at = datetime('now')
      WHERE id = ? AND status = 'suspended'`
  );
  const retire = db.prepare(
    `UPDATE aliases SET status = 'retired', status_reason = ?, status_at = datetime('now')
      WHERE id = ? AND status = 'suspended'`
  );
  const undecided = db.prepare(
    `UPDATE aliases SET status_reason = ?, status_at = datetime('now') WHERE id = ? AND status = 'suspended'`
  );
  const counts: VerdictCounts = { confirmed: 0, retired: 0, undecided: 0, unanswered: 0 };
  db.transaction(() => {
    for (const pair of batch) {
      const v = byId.get(pair.pair_id);
      const id = Number(pair.pair_id);
      if (v?.decision === 'same') {
        counts.confirmed += confirm.run(REPAIR_CONFIRMED_METHOD, id).changes;
      } else if (v?.decision === 'different') {
        counts.retired += retire.run(`different: ${v.reason}`.slice(0, 300), id).changes;
      } else if (v?.decision === 'ambiguous' && !NOT_A_VERDICT.test(v.reason)) {
        counts.undecided += undecided.run(REPAIR_UNDECIDED_REASON, id).changes;
      } else {
        counts.unanswered++;
      }
    }
  })();
  return counts;
}
