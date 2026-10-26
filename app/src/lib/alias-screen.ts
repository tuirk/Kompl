/**
 * The alias screen: sets aside stored aliases made before schema v29 whose
 * names have a clearly wrong shape (alias-shapes.ts), so they stop binding
 * new sources to the wrong page. No LLM. Runs in the app, after boot
 * (instrumentation.ts) and after every backup import (api/import).
 *
 * It looks only at active rows with no method (made before v29, or by an
 * older image, or restored from an older backup); rows the resolver made
 * since record their method and passed its own rules. Suspended rows stay
 * in the table, are never deleted, and a new resolver match re-activates
 * them (bulkInsertAliases). Each run writes in one transaction: the
 * suspensions, one activity event when it suspended any, and the record
 * that it ran (version and the highest alias id it covered).
 *
 * Names whose content words differ need their name-only similarity from
 * the embedding model, through nlp-service. When it can't be reached the
 * run writes nothing and is tried again later (scheduleAliasScreen), and
 * otherwise on the next boot or import.
 */

import type Database from 'better-sqlite3';
import type { ActivityEventType } from './activity-events';
import { aliasShape, type SuspendReason } from './alias-shapes';

/** Bump when alias-shapes.ts changes what it sets aside: every row is screened again. */
export const ALIAS_SCREEN_VERSION = '1';
export const ALIAS_SCREEN_VERSION_KEY = 'alias_screen_version';
/** Highest alias id the last run covered; a boot run looks only at newer rows. */
export const ALIAS_SCREEN_THROUGH_KEY = 'alias_screen_through_id';
/** Names whose content words differ are set aside below this name-only similarity (Layer 2's merge bar). */
export const NAME_SIMILARITY_FLOOR = 0.9;
/** Pairs per /resolve/name-similarity request (nlp-service MAX_NAME_PAIRS is 1000). */
const SIMILARITY_CHUNK = 500;
/** Retry delays after nlp-service could not be reached; then the next boot or import. */
const RETRY_DELAYS_MS = [30_000, 60_000, 120_000, 300_000, 600_000];
const EVENT: ActivityEventType = 'aliases_suspended';
const EXAMPLES = 5;

export type ScreenTrigger = 'boot' | 'import';
export type NameSimilarity = (pairs: Array<{ a: string; b: string }>) => Promise<number[]>;

export interface AliasScreenResult {
  /** done: written; needs_similarity: similarity was not allowed; unavailable: nlp-service failed. */
  status: 'done' | 'needs_similarity' | 'unavailable';
  screened: number;
  suspended: number;
}

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

/** Name-only similarity of each pair from nlp-service, in order. Throws when it can't answer. */
export async function fetchNameSimilarity(pairs: Array<{ a: string; b: string }>): Promise<number[]> {
  const out: number[] = [];
  for (let i = 0; i < pairs.length; i += SIMILARITY_CHUNK) {
    const chunk = pairs.slice(i, i + SIMILARITY_CHUNK);
    // The model may still be loading after a restart: allow it time.
    const res = await fetch(`${NLP_SERVICE_URL}/resolve/name-similarity`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ pairs: chunk }),
      signal: AbortSignal.timeout(120_000),
    });
    if (!res.ok) throw new Error(`name_similarity_failed: ${res.status}`);
    const body = (await res.json()) as { items?: Array<{ a: string; b: string; similarity: number }>; count?: number };
    const items = body.items ?? [];
    if (items.length !== chunk.length || items.some((it, k) => it.a !== chunk[k].a || it.b !== chunk[k].b)) {
      throw new Error('name_similarity_mismatch');
    }
    out.push(...items.map((it) => it.similarity));
  }
  return out;
}

function setting(db: Database.Database, key: string): string | null {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key) as { value: string } | undefined;
  return row?.value ?? null;
}

/**
 * Screen the aliases that need it. `force` screens every active row with no
 * method (after an import); otherwise only rows newer than the last run of
 * this version. With `similarity` null, a run that needs it writes nothing.
 */
export async function screenAliases(
  db: Database.Database,
  opts: { trigger: ScreenTrigger; force?: boolean; similarity: NameSimilarity | null }
): Promise<AliasScreenResult> {
  const sameVersion = setting(db, ALIAS_SCREEN_VERSION_KEY) === ALIAS_SCREEN_VERSION;
  const fromId = opts.force || !sameVersion ? 0 : Number(setting(db, ALIAS_SCREEN_THROUGH_KEY) ?? 0) || 0;
  const throughId = (db.prepare('SELECT COALESCE(MAX(id), 0) AS n FROM aliases').get() as { n: number }).n;
  const rows = db
    .prepare(
      `SELECT id, alias, canonical_name FROM aliases
        WHERE id > ? AND method IS NULL AND COALESCE(status, 'active') = 'active'
          AND canonical_name IS NOT NULL
        ORDER BY id`
    )
    .all(fromId) as Array<{ id: number; alias: string; canonical_name: string }>;

  const people = new Set(
    (db.prepare(`SELECT DISTINCT canonical_name FROM entity_mentions WHERE entity_type = 'PERSON'`).all() as Array<{
      canonical_name: string;
    }>).map((r) => r.canonical_name.toLowerCase())
  );
  const suspend = new Map<number, SuspendReason>();
  const ask: typeof rows = [];
  for (const r of rows) {
    const person = people.has(r.alias.toLowerCase()) || people.has(r.canonical_name.toLowerCase());
    const shape = aliasShape(r.alias, r.canonical_name, person);
    if (shape === 'needs_similarity') ask.push(r);
    else if (shape !== 'keep') suspend.set(r.id, shape);
  }

  if (ask.length > 0) {
    if (!opts.similarity) return { status: 'needs_similarity', screened: rows.length, suspended: 0 };
    let sims: number[];
    try {
      sims = await opts.similarity(ask.map((r) => ({ a: r.alias, b: r.canonical_name })));
      if (sims.length !== ask.length || !sims.every(Number.isFinite)) throw new Error('name_similarity_mismatch');
    } catch {
      return { status: 'unavailable', screened: rows.length, suspended: 0 };
    }
    ask.forEach((r, k) => {
      if (sims[k] < NAME_SIMILARITY_FLOOR) suspend.set(r.id, 'content_words');
    });
  }

  const byId = new Map(rows.map((r) => [r.id, r]));
  // Re-checked per row: a compile may have re-activated or recorded one meanwhile.
  const update = db.prepare(
    `UPDATE aliases SET status = 'suspended', status_reason = ?, status_at = datetime('now')
      WHERE id = ? AND method IS NULL AND COALESCE(status, 'active') = 'active'`
  );
  const saveSetting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
  const suspended = db.transaction(() => {
    const done: Array<{ alias: string; canonical: string; reason: SuspendReason }> = [];
    for (const [id, reason] of suspend) {
      if (update.run(reason, id).changes === 0) continue;
      const r = byId.get(id)!;
      done.push({ alias: r.alias, canonical: r.canonical_name, reason });
    }
    if (done.length > 0) {
      const reasons: Record<string, number> = {};
      for (const d of done) reasons[d.reason] = (reasons[d.reason] ?? 0) + 1;
      db.prepare(`INSERT INTO activity_log (action_type, source_id, details) VALUES (?, NULL, ?)`).run(
        EVENT,
        JSON.stringify({
          trigger: opts.trigger,
          suspended: done.length,
          reasons,
          examples: done.slice(0, EXAMPLES).map((d) => ({ alias: d.alias, canonical: d.canonical })),
        })
      );
    }
    saveSetting.run(ALIAS_SCREEN_VERSION_KEY, ALIAS_SCREEN_VERSION);
    saveSetting.run(ALIAS_SCREEN_THROUGH_KEY, String(Math.max(throughId, fromId)));
    return done.length;
  })();
  return { status: 'done', screened: rows.length, suspended };
}

/**
 * Screen now if no nlp-service call is needed; otherwise hand the run to
 * scheduleAliasScreen and return at once, so boot and import never wait on
 * the embedding model.
 */
export async function screenAliasesNowOrLater(
  db: Database.Database,
  trigger: ScreenTrigger,
  opts: { force?: boolean } = {}
): Promise<AliasScreenResult> {
  const result = await screenAliases(db, { trigger, force: opts.force, similarity: null });
  if (result.status === 'needs_similarity') void scheduleAliasScreen(db, trigger, opts);
  else if (result.screened > 0) {
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'alias_screen', trigger, ...result }));
  }
  return result;
}

let queue: Promise<unknown> = Promise.resolve();

/** Resolves when the screen runs queued so far have finished (tests). */
export function aliasScreenIdle(): Promise<unknown> {
  return queue;
}

/**
 * Run the screen in the background, one run at a time, asking nlp-service
 * for similarity. A run that can't reach it is tried again after
 * RETRY_DELAYS_MS; a closed database ends the retries.
 */
export function scheduleAliasScreen(
  db: Database.Database,
  trigger: ScreenTrigger,
  opts: { force?: boolean } = {},
  attempt = 0
): Promise<AliasScreenResult | null> {
  const run = queue.then(async () => {
    if (!db.open) return null;
    const result = await screenAliases(db, { trigger, force: opts.force, similarity: fetchNameSimilarity });
    const retryIn = result.status === 'unavailable' ? RETRY_DELAYS_MS[attempt] : undefined;
    console.log(JSON.stringify({ ts: new Date().toISOString(), event: 'alias_screen', trigger, attempt, ...result, retry_in_ms: retryIn ?? null }));
    if (retryIn !== undefined) {
      const timer = setTimeout(() => void scheduleAliasScreen(db, trigger, opts, attempt + 1), retryIn);
      (timer as { unref?: () => void }).unref?.();
    }
    return result;
  });
  const settled = run.catch((err: unknown) => {
    console.error(JSON.stringify({ ts: new Date().toISOString(), event: 'alias_screen_failed', trigger, error: err instanceof Error ? err.message : String(err) }));
    return null;
  });
  queue = settled;
  return settled;
}
