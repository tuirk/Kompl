/**
 * POST /api/compile/resolve
 *
 * Part 2b — Entity Resolution.
 * Resolves entity duplicates across all sources in a session using a
 * three-layer cascading matcher:
 *
 *   1. getExtractionsBySession(sessionId) — flatten all entity lists
 *   2. Layer 1: POST /resolve/fuzzy     — spellings of one name (exact,
 *                                          skeleton, plural, near-spelling,
 *                                          acronym), existing aliases and pages
 *   3. Layer 2: POST /resolve/embedding — cosine similarity via sentence-transformers
 *              (>0.9 same, <0.7 different, 0.7–0.9 ambiguous) over the
 *              entities Layer 1 left alone and Layer 1's groups
 *   4. Layer 3: POST /resolve/disambiguate — the LLM on ambiguous pairs, up to
 *              a cap, ranked by lib/resolve-ranking.ts; verdicts come back
 *              by pair_id and 'same' verdicts fold into the groups
 *   5. bulkInsertAliases() — persist alias → canonical mappings
 *
 * The resolved canonical list is the ephemeral output consumed by 2c's
 * page planner. Sources stay 'extracted'. No new status changes here.
 *
 * The alias table IS the persistent artifact — every resolved group's
 * aliases are upserted, so subsequent sessions hit Layer 1 instantly.
 *
 * Idempotent: re-running produces the same result (aliases skip duplicates).
 *
 * Request:  { session_id: string }
 * Response: { session_id, canonical_entities, stats }
 *
 * Errors:
 *   400 — invalid request or no extracted sources for this session
 *   429 — nlp-service rate limit (LLM disambiguation)
 *   503 — daily cost ceiling exceeded
 *   500 — unexpected error
 */

import { NextResponse } from 'next/server';
import {
  bulkInsertAliases,
  getAliases,
  getEffectiveCompileModel,
  getEntityAndConceptPageTitles,
  getExtractionsBySession,
  logActivity,
  normalizeSessionMentionsToCanonical,
} from '../../../../lib/db';
import { computeDisambiguateMs } from '../../../../lib/compile-timeouts';
import { makeDispatcher } from '../../../../lib/long-http-agent';
import { numericConflict } from '../../../../lib/name-guard';
import { MAX_DISAMBIGUATE_PAIRS, rankForLayer3 } from '../../../../lib/resolve-ranking';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

// Must match nlp-service/routers/resolution.py EXISTING_PAGE_SENTINEL. Used to
// tag the synthetic EntityInput representing an existing wiki page title when
// Layer 2 flags a session-to-wiki pair as ambiguous. Downstream Layer 3
// handling treats this value as a non-source so the sentinel never leaks
// into real source_ids.
const EXISTING_PAGE_SENTINEL = '__existing_page__';

// Must match nlp-service/routers/resolution.py GROUP_SENTINEL_PREFIX. In an
// AmbiguousPair, source_id `__group__:<k>` stands for resolved[k] of the same
// /resolve/embedding response: a group Layer 1 or Layer 2 formed. A Layer 3
// 'same' verdict folds into that group; the prefix never reaches source_ids.
const GROUP_SENTINEL_PREFIX = '__group__:';

// Groups bound to a known canonical (an existing page title or a stored
// alias). Mirrors _ANCHORED_METHODS in nlp-service/routers/resolution.py.
const ANCHORED_METHODS = new Set(['existing_page_title', 'existing_alias']);

// Kinds a group may hold together. Mirrors _COMPATIBLE_TYPE_GROUPS in
// nlp-service/routers/resolution.py.
const KIND_FAMILIES: string[][] = [['ORG', 'PRODUCT'], ['CONCEPT', 'OTHER']];

// ── Type definitions (mirror nlp-service Pydantic models) ─────────────────────

interface EntityInput {
  name: string;
  type: string;
  source_id: string;
  context: string;
}

interface ResolvedGroup {
  canonical: string;
  type: string;
  aliases: string[];
  source_ids: string[];
  method: string;
}

interface GroupInput extends ResolvedGroup {
  context: string;
}

interface AmbiguousPair {
  entity_a: EntityInput;
  entity_b: EntityInput;
  similarity: number;
  name_similarity: number; // cosine of the names alone; ranks pairs for the capped Layer 3
}

interface FuzzyResolveResponse {
  resolved: ResolvedGroup[];
  unresolved: EntityInput[];
}

interface EmbeddingResolveResponse {
  resolved: ResolvedGroup[];
  ambiguous: AmbiguousPair[];
  unresolved: EntityInput[];
}

interface DisambiguateResponse {
  results: Array<{
    pair_id: string | null; // the pair_id sent with the pair
    entity_a: string;
    entity_b: string;
    decision: string;
    canonical: string | null; // for 'same': one of the pair's two names
    reason: string;
  }>;
  failed_pairs: number; // pairs whose LLM batch failed; answered 'ambiguous'
}

// ── NLP service call helpers ───────────────────────────────────────────────────

interface ExistingPageTitle {
  title: string;
  page_type: string;  // 'entity' | 'concept'
}

async function callFuzzy(
  entities: EntityInput[],
  existingAliases: Array<{ alias: string; canonical: string }>,
  existingPageTitles: ExistingPageTitle[]
): Promise<FuzzyResolveResponse> {
  const res = await fetch(`${NLP_SERVICE_URL}/resolve/fuzzy`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entities,
      existing_aliases: existingAliases,
      existing_page_titles: existingPageTitles,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`fuzzy_failed: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json() as Promise<FuzzyResolveResponse>;
}

async function callEmbedding(
  entities: EntityInput[],
  groups: GroupInput[],
  existingPageTitles: ExistingPageTitle[]
): Promise<EmbeddingResolveResponse> {
  const res = await fetch(`${NLP_SERVICE_URL}/resolve/embedding`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      entities,
      groups,
      existing_page_titles: existingPageTitles,
    }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) throw new Error(`embedding_failed: ${res.status} ${await res.text().catch(() => '')}`);
  return res.json() as Promise<EmbeddingResolveResponse>;
}

async function callDisambiguate(
  pairs: Array<AmbiguousPair & { pair_id: string }>,
  compileModel?: string,
): Promise<DisambiguateResponse> {
  // nlp-service makes one LLM call per 10 pairs, one after another, so the
  // budget grows with the pair count (lib/compile-timeouts.ts). A fixed 10
  // minutes let two slow DeepSeek batches abort the whole resolve.
  const timeoutMs = computeDisambiguateMs(pairs.length);
  const res = await fetch(`${NLP_SERVICE_URL}/resolve/disambiguate`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      pairs,
      ...(compileModel ? { compile_model: compileModel } : {}),
    }),
    signal: AbortSignal.timeout(timeoutMs),
    // @ts-expect-error — dispatcher is an undici-specific fetch option not in the DOM RequestInit type
    dispatcher: makeDispatcher(timeoutMs), // undici's default 300s headersTimeout would fire first
  });
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 429) throw Object.assign(new Error('llm_rate_limited'), { status: 429 });
    if (res.status === 503) throw Object.assign(new Error('daily_cost_ceiling'), { status: 503 });
    throw new Error(`disambiguate_failed: ${res.status} ${detail}`);
  }
  return res.json() as Promise<DisambiguateResponse>;
}

/**
 * The context a Layer 1 group speaks with in Layers 2 and 3: the extraction
 * context of one of its own mentions, preferring the canonical spelling.
 */
function groupContext(group: ResolvedGroup, pool: EntityInput[]): string {
  const names = new Set([group.canonical, ...group.aliases].map((n) => n.toLowerCase()));
  const sources = new Set(group.source_ids);
  const own = pool.filter((e) => e.context && sources.has(e.source_id) && names.has(e.name.toLowerCase()));
  return (own.find((e) => e.name.toLowerCase() === group.canonical.toLowerCase()) ?? own[0])?.context ?? '';
}

// ── Main handler ───────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { session_id } = body as { session_id?: string };
  if (typeof session_id !== 'string' || !session_id.trim()) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }

  // Step 1: get all extractions for this session. created_at has one-second
  // resolution and sources extract four at a time, so ties are ordered by
  // source too: the same session always gives the resolver the same input.
  const byText = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const extractions = getExtractionsBySession(session_id).sort(
    (x, y) => byText(x.created_at, y.created_at) || byText(x.source_id, y.source_id)
  );
  if (extractions.length === 0) {
    return NextResponse.json(
      { error: 'no_extracted_sources', detail: 'No extracted sources found for this session. Run /api/compile/extract for each source first.' },
      { status: 400 }
    );
  }

  // Flatten all entities + concepts across all sources into the same input pool.
  // Concepts are injected as synthetic EntityInputs with type='CONCEPT' and
  // context=description so they ride the same 3-layer pipeline as entities.
  // Type compatibility in the resolver keeps concept groups separate from
  // non-concept groups, so nothing wrongly merges across kinds. The response
  // partitions results back into canonical_entities vs canonical_concepts.
  const allEntities: EntityInput[] = extractions.flatMap((ext) => {
    let llm: {
      entities?: Array<{ name: string; type: string; context?: string }>;
      concepts?: Array<{ name: string; description?: string }>;
    };
    try {
      llm = JSON.parse(ext.llm_output) as typeof llm;
    } catch {
      return [];
    }
    const entityInputs: EntityInput[] = (llm.entities ?? []).map((ent) => ({
      name: ent.name,
      type: ent.type,
      source_id: ext.source_id,
      context: ent.context ?? '',
    }));
    const conceptInputs: EntityInput[] = (llm.concepts ?? [])
      .filter((c) => typeof c.name === 'string' && c.name.trim().length > 0)
      .map((c) => ({
        name: c.name.trim(),
        type: 'CONCEPT',
        source_id: ext.source_id,
        context: c.description ?? '',
      }));
    return [...entityInputs, ...conceptInputs];
  });

  if (allEntities.length === 0) {
    return NextResponse.json({
      session_id,
      canonical_entities: [],
      canonical_concepts: [],
      stats: { total_raw: 0, resolved_fuzzy: 0, resolved_embedding: 0, resolved_llm: 0, final_canonical: 0 },
    });
  }

  // Step 2: get existing aliases for returning session optimisation
  const storedAliases = getAliases();
  const existingAliases = storedAliases.map((a) => ({
    alias: a.alias,
    canonical: a.canonical_name,
  }));

  // Step 2b: get existing entity/concept page titles so the resolver can match
  // session entities against the wiki cross-session — closes the split-session
  // duplicate gap that the alias drawer alone can't cover.
  const existingPageTitles: ExistingPageTitle[] = getEntityAndConceptPageTitles();

  try {
    // Layer 1 — fuzzy
    const fuzzyResult = await callFuzzy(allEntities, existingAliases, existingPageTitles);
    const resolved1 = fuzzyResult.resolved;
    const unresolved1 = fuzzyResult.unresolved;

    // Layer 2 — embedding. Layer 1's groups go along, so a name Layer 1
    // grouped or bound to a page is still compared with the rest of the
    // session: "APCA", bound to its page, never met "APCA contrast algorithm"
    // (2026-10-17, session e55c740b). The response's `resolved` holds the
    // final state of every group passed in, so it replaces resolved1.
    let resolved2: ResolvedGroup[] = [];
    let ambiguous2: AmbiguousPair[] = [];
    let unresolved2: EntityInput[] = [];
    const passedThrough = unresolved1.length > 0 || resolved1.length > 0;

    if (passedThrough) {
      const groupInputs: GroupInput[] = resolved1.map((g) => ({
        canonical: g.canonical,
        type: g.type,
        aliases: g.aliases,
        source_ids: g.source_ids,
        method: g.method,
        context: groupContext(g, allEntities),
      }));
      const embResult = await callEmbedding(unresolved1, groupInputs, existingPageTitles);
      resolved2 = embResult.resolved;
      ambiguous2 = embResult.ambiguous;
      unresolved2 = embResult.unresolved;
    }

    // Layer 3 — LLM disambiguation (only if there are ambiguous pairs)
    // The groups so far, which each Layer 3 'same' folds into: a pair's
    // `__group__:<k>` side is groups[k], `parent` follows a group folded into
    // another, and groups Layer 3 forms are appended.
    const groups: ResolvedGroup[] = (passedThrough ? resolved2 : resolved1).map((g) => ({
      ...g,
      aliases: [...g.aliases],
      source_ids: [...g.source_ids],
    }));
    const passedCount = groups.length;
    const parent = groups.map((_, i) => i);
    const find = (i: number): number => {
      let root = i;
      while (parent[root] !== root) root = parent[root];
      return root;
    };
    const isAnchored = (g: ResolvedGroup) => ANCHORED_METHODS.has(g.method);
    const isExistingPage = (e: EntityInput) => e.source_id === EXISTING_PAGE_SENTINEL;
    const isGroupRef = (e: EntityInput) => e.source_id.startsWith(GROUP_SENTINEL_PREFIX);
    const groupOf = (e: EntityInput): number | null => {
      if (!isGroupRef(e)) return null;
      const k = Number(e.source_id.slice(GROUP_SENTINEL_PREFIX.length));
      return Number.isInteger(k) && k >= 0 && k < passedCount ? find(k) : null;
    };
    // Real session entities of a pair: not the page sentinel, not a group.
    const loneSides = (pair: AmbiguousPair) =>
      [pair.entity_a, pair.entity_b].filter((e) => !isExistingPage(e) && !isGroupRef(e));
    const anchoredGroup = new Map<string, number>(); // canonical (lower case) → group bound to it
    groups.forEach((g, i) => {
      const key = g.canonical.toLowerCase();
      if (isAnchored(g) && !anchoredGroup.has(key)) anchoredGroup.set(key, i);
    });

    const ambiguousRemaining: EntityInput[] = [];
    // Session entities already in a merged group: Layer 2's (Layer 1's passed
    // through), then each Layer 3 'same'. An entity can sit in several pairs
    // ("APCA" vs "APCA contrast algorithm" and vs an existing page), and it
    // joins one group only — the first 'same' wins, and verdicts touching an
    // existing page come first, so the page does. A 'different' verdict on
    // another pair must not also emit it as a singleton, or plan sees the
    // name twice and writes it to two pages (2026-10-17, session e55c740b).
    // Keyed with the kind too: a group's names cover the kinds it can hold,
    // so a CONCEPT "Chrome" beside an ORG group "Chrome" from the same
    // source is still its own entity.
    const mergedKeys = new Set<string>();
    const entityKey = (e: EntityInput) => `${e.name}|||${e.source_id}|||${e.type}`;
    for (const g of groups) {
      const family = KIND_FAMILIES.find((f) => f.includes(g.type));
      const kinds = family === undefined ? [g.type] : family;
      for (const name of [g.canonical, ...g.aliases]) {
        for (const sid of g.source_ids) for (const kind of kinds) mergedKeys.add(`${name}|||${sid}|||${kind}`);
      }
    }
    // Names whose numbers differ are never one thing ("Python 2" / "Python 3"),
    // so a verdict never folds them together, even through a third name.
    const numbersClash = (xs: string[], ys: string[]) =>
      xs.some((x) => ys.some((y) => numericConflict(x, y) === 'hard'));
    const namesOf = (g: ResolvedGroup) => [g.canonical, ...g.aliases];

    const addName = (g: ResolvedGroup, name: string) => {
      if (name !== g.canonical && !g.aliases.includes(name)) g.aliases.push(name);
    };
    const addGroup = (g: ResolvedGroup) => {
      groups.push(g);
      parent.push(groups.length - 1);
      if (isAnchored(g)) anchoredGroup.set(g.canonical.toLowerCase(), groups.length - 1);
    };
    const absorb = (gi: number, e: EntityInput): boolean => {
      if (numbersClash(namesOf(groups[gi]), [e.name])) return false;
      addName(groups[gi], e.name);
      if (!groups[gi].source_ids.includes(e.source_id)) groups[gi].source_ids.push(e.source_id);
      mergedKeys.add(entityKey(e));
      return true;
    };
    const rename = (g: ResolvedGroup, canonical: string) => {
      if (canonical === g.canonical) return;
      const previous = g.canonical;
      g.canonical = canonical;
      g.aliases = g.aliases.filter((a) => a !== canonical);
      addName(g, previous);
    };
    // Folds one group into the other. An anchored canonical wins; otherwise
    // the one more sources back, and on a tie the one Layer 3 picked. Two
    // anchored groups are two pages and never fold.
    const join = (x: number, y: number, picked: string): boolean => {
      let into = find(x);
      let from = find(y);
      if (into === from) return true;
      if (isAnchored(groups[into]) && isAnchored(groups[from])) return false;
      if (numbersClash(namesOf(groups[into]), namesOf(groups[from]))) return false;
      const [gx, gy] = [groups[into], groups[from]];
      if (isAnchored(gy) || (!isAnchored(gx) && (gy.source_ids.length > gx.source_ids.length ||
          (gy.source_ids.length === gx.source_ids.length && picked === gy.canonical)))) {
        [into, from] = [from, into];
      }
      const [target, source] = [groups[into], groups[from]];
      for (const name of [source.canonical, ...source.aliases]) addName(target, name);
      for (const sid of source.source_ids) if (!target.source_ids.includes(sid)) target.source_ids.push(sid);
      if (!isAnchored(target)) target.method = 'llm';
      parent[from] = into;
      return true;
    };
    // Applies one Layer 3 'same' verdict; false when it cannot be applied.
    const applySame = (pair: AmbiguousPair, picked: string): boolean => {
      const sides = [pair.entity_a, pair.entity_b];
      const ids = sides.map(groupOf).filter((k): k is number => k !== null);
      if (ids.length !== sides.filter(isGroupRef).length) return false; // malformed group reference
      const lone = loneSides(pair);
      if (ids.length + lone.length === 0) return false; // two pages: nothing of this session's
      const page = sides.find(isExistingPage);
      if (page) {
        // The wiki is authoritative: whatever Layer 3 picked, the page title
        // is the canonical, and a group already bound to the page takes it in.
        const holder = anchoredGroup.get(page.name.toLowerCase());
        if (ids.length > 0) {
          const g = groups[ids[0]];
          if (isAnchored(g)) return g.canonical.toLowerCase() === page.name.toLowerCase();
          if (holder !== undefined) return join(holder, ids[0], page.name);
          rename(g, page.name);
          g.method = 'existing_page_title';
          anchoredGroup.set(page.name.toLowerCase(), ids[0]);
          return true;
        }
        if (holder !== undefined) return absorb(find(holder), lone[0]);
        addGroup({
          canonical: page.name,
          type: lone[0].type,
          aliases: lone[0].name !== page.name ? [lone[0].name] : [],
          source_ids: [lone[0].source_id],
          method: 'existing_page_title',
        });
        mergedKeys.add(entityKey(lone[0]));
        return true;
      }
      if (ids.length === 2) return join(ids[0], ids[1], picked);
      if (ids.length === 1) {
        const g = groups[ids[0]];
        if (numbersClash(namesOf(g), [lone[0].name])) return false;
        if (!isAnchored(g) && g.source_ids.length <= 1 && picked === lone[0].name) rename(g, picked);
        return absorb(ids[0], lone[0]);
      }
      addGroup({
        canonical: picked,
        type: pair.entity_a.type,
        aliases: lone.map((e) => e.name).filter((n) => n !== picked),
        source_ids: [...new Set(lone.map((e) => e.source_id))],
        method: 'llm',
      });
      for (const e of lone) mergedKeys.add(entityKey(e));
      return true;
    };

    // App-side mirror of the nlp-service DISAMBIGUATE_MAX_PAIRS cap
    // (CLAUDE.md rule #7): never ask for more LLM pairs than the service
    // will process. Overflow pairs take the same path as an 'ambiguous' LLM
    // verdict — entities stay separate singletons, a safe degradation —
    // and are reported in stats and the activity log.
    // Who gets a slot is ranked as in nlp-service (lib/resolve-ranking.ts):
    // pairs against the wiki or across sources before pairs one source
    // names both sides of; abbreviations first in each tier; then name
    // similarity, so context likeness alone never takes a slot.
    const sourcesOf = (e: EntityInput): string[] => {
      if (isExistingPage(e)) return [];
      if (!isGroupRef(e)) return [e.source_id];
      const k = groupOf(e);
      return k === null ? [] : groups[k].source_ids;
    };
    // A pair touching the wiki: an existing page, or a group bound to one.
    const touchesWiki = (pair: AmbiguousPair) =>
      [pair.entity_a, pair.entity_b].some((e) => {
        const k = groupOf(e);
        return isExistingPage(e) || (k !== null && isAnchored(groups[k]));
      });
    const oneSource = (pair: AmbiguousPair) => {
      if (touchesWiki(pair)) return false;
      const a = new Set(sourcesOf(pair.entity_a));
      return sourcesOf(pair.entity_b).some((s) => a.has(s));
    };
    const ranked = rankForLayer3(ambiguous2, oneSource);
    const cappedAmbiguous = ranked.slice(0, MAX_DISAMBIGUATE_PAIRS);
    const overflowAmbiguous = ranked.slice(MAX_DISAMBIGUATE_PAIRS);
    let llmFailed = 0;
    if (overflowAmbiguous.length > 0) {
      console.warn(
        `[resolve] ${ambiguous2.length} ambiguous pairs exceed cap ${MAX_DISAMBIGUATE_PAIRS}; ` +
          `${overflowAmbiguous.length} pairs kept separate without LLM disambiguation`
      );
      for (const pair of overflowAmbiguous) ambiguousRemaining.push(...loneSides(pair));
    }

    if (cappedAmbiguous.length > 0) {
      // Each pair goes out with an id and its verdict comes back with it.
      // Matching by name gave two pairs named "Mercury" / "Mercury" (a
      // PERSON and a LOCATION group, each against a CONCEPT) one verdict.
      const sent = cappedAmbiguous.map((pair, k) => ({ ...pair, pair_id: String(k) }));
      const disambResult = await callDisambiguate(sent, getEffectiveCompileModel(session_id));
      llmFailed = disambResult.failed_pairs;
      const verdicts = new Map(
        disambResult.results.filter((r) => r.pair_id !== null).map((r) => [r.pair_id, r] as const)
      );

      // Verdicts touching the wiki are applied first, then the rest, each in
      // the ranked order.
      const foldOrder = [
        ...sent.filter(touchesWiki),
        ...sent.filter((pair) => !touchesWiki(pair)),
      ];

      for (const pair of foldOrder) {
        const result = verdicts.get(pair.pair_id);
        const lone = loneSides(pair);
        const alreadyMerged = lone.some((e) => mergedKeys.has(entityKey(e)));
        const applied =
          result?.decision === 'same' && !!result.canonical && !alreadyMerged && applySame(pair, result.canonical);
        // "different", "ambiguous", a side already merged or two pages — real
        // session entities flow back to singletons (merged ones are dropped
        // below); the sentinel and group sides are discarded.
        if (!applied) ambiguousRemaining.push(...lone);
      }
    }

    // Merge all resolved groups + singletons
    const singletonEntities = [
      ...unresolved2,
      ...ambiguousRemaining,
    ];
    // Deduplicate singletons (an entity can appear in both lists if it was in
    // multiple pairs) and drop the ones already in a merged group.
    const seenSingletons = new Set<string>();
    const dedupedSingletons: ResolvedGroup[] = [];
    for (const e of singletonEntities) {
      const key = entityKey(e);
      if (!seenSingletons.has(key) && !mergedKeys.has(key)) {
        seenSingletons.add(key);
        dedupedSingletons.push({
          canonical: e.name,
          type: e.type,
          aliases: [],
          source_ids: [e.source_id],
          method: 'none',
        });
      }
    }

    const finalGroups = groups.filter((_, i) => find(i) === i);
    const allCanonical: ResolvedGroup[] = [
      ...finalGroups,
      ...dedupedSingletons,
    ];

    // Partition by type — concepts ran through the same pipeline so they could
    // cross-session dedup against existing concept pages, but the plan step
    // treats them as a distinct rule (Rule 3 concepts vs Rule 2 entities).
    const canonicalEntities: ResolvedGroup[] = [];
    const canonicalConcepts: ResolvedGroup[] = [];
    for (const g of allCanonical) {
      if (g.type === 'CONCEPT') {
        canonicalConcepts.push(g);
      } else {
        canonicalEntities.push(g);
      }
    }

    // Step 5: persist aliases for both kinds. The aliases table is untagged —
    // page_type is inferred via canonical_page_id once the page is committed.
    const aliasesToInsert = allCanonical.flatMap((g) =>
      g.aliases.map((a) => ({ alias: a, canonical: g.canonical }))
    );
    if (aliasesToInsert.length > 0) {
      bulkInsertAliases(aliasesToInsert);
      // Re-canonicalise this session's mention rows to the resolver-chosen
      // canonicals. Extract-commit pinned via historical aliases only; the
      // resolver just minted NEW aliases (e.g. cross-session page-title
      // anchors) that invalidate those initial pins for this session's
      // sources. Without this, plan's threshold counts + source_ids lookups
      // miss the current session's contribution when its extraction used a
      // variant spelling that the resolver has now canonicalised.
      normalizeSessionMentionsToCanonical(session_id, aliasesToInsert);
    }

    // Pairs Layer 3 never judged (over the cap, or in a failed LLM batch)
    // may be duplicates left as separate pages; say so where the user looks.
    if (overflowAmbiguous.length > 0 || llmFailed > 0) {
      logActivity('resolution_pairs_unchecked', {
        source_id: null,
        session_id,
        step_key: 'resolve',
        details: {
          session_id,
          over_cap:   overflowAmbiguous.length,
          llm_failed: llmFailed,
          cap:        MAX_DISAMBIGUATE_PAIRS,
        },
      });
    }

    logActivity('resolution_complete', {
      source_id: null,
      session_id,
      step_key: 'resolve',
      details: {
        session_id,
        merged_count:   allEntities.length - allCanonical.length,
        resolved_count: allCanonical.length,
        total_raw:      allEntities.length,
        entity_count:   canonicalEntities.length,
        concept_count:  canonicalConcepts.length,
      },
    });

    // Names each layer added: Layer 2's response repeats Layer 1's groups,
    // and Layer 3 folds into those groups.
    const aliasCount = (gs: ResolvedGroup[]) => gs.reduce((sum, g) => sum + g.aliases.length, 0);
    const beforeLlm = passedThrough ? resolved2 : resolved1;
    return NextResponse.json({
      session_id,
      canonical_entities: canonicalEntities,
      canonical_concepts: canonicalConcepts,
      stats: {
        total_raw: allEntities.length,
        resolved_fuzzy: aliasCount(resolved1),
        resolved_embedding: passedThrough ? Math.max(0, aliasCount(resolved2) - aliasCount(resolved1)) : 0,
        resolved_llm: Math.max(0, aliasCount(finalGroups) - aliasCount(beforeLlm)),
        final_canonical: allCanonical.length,
        canonical_entities: canonicalEntities.length,
        canonical_concepts: canonicalConcepts.length,
        llm_pairs: cappedAmbiguous.length,
        llm_pairs_over_cap: overflowAmbiguous.length,
        llm_pairs_failed: llmFailed,
      },
    });
  } catch (err) {
    const e = err as Error & { status?: number };
    if (e.status === 429) {
      return NextResponse.json({ error: 'llm_rate_limited' }, { status: 429 });
    }
    if (e.status === 503) {
      return NextResponse.json({ error: 'daily_cost_ceiling' }, { status: 503 });
    }
    // Own the stack trace here — orchestrator only sees the serialised message.
    console.error('[resolve]', err);
    return NextResponse.json({ error: e.message ?? 'unknown_error' }, { status: 500 });
  }
}
