/**
 * Canonical shape for wiki lint findings — shared by lint-pass route,
 * Settings UI, digest, and activity feed.
 */

export interface LintOrphanPage {
  page_id: string;
  title: string;
}

export interface LintStalePage {
  page_id: string;
  title: string;
  last_updated: string;
}

export interface LintMissingCrossRef {
  entity_text: string;
  mention_count: number;
}

export interface LintDeadProvenance {
  provenance_id: number;
  page_id: string;
  page_title: string;
  source_id: string;
}

export interface LintContradiction {
  page_a_id: string;
  page_a_title: string;
  page_b_id: string;
  page_b_title: string;
  claim: string;
  severity: string;
}

export interface LintResult {
  orphan_pages: LintOrphanPage[];
  stale_pages: LintStalePage[];
  missing_cross_refs: LintMissingCrossRef[];
  dead_provenance: LintDeadProvenance[];
  contradictions: LintContradiction[];
  run_duration_ms: number;
}

export interface LintCounts {
  orphans: number;
  stale: number;
  crossRefs: number;
  deadProv: number;
  contradictions: number;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function parseOrphanPages(raw: unknown): LintOrphanPage[] {
  if (!Array.isArray(raw)) return [];
  const out: LintOrphanPage[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const page_id = typeof item.page_id === 'string' ? item.page_id : '';
    const title = typeof item.title === 'string' ? item.title : page_id;
    if (page_id) out.push({ page_id, title });
  }
  return out;
}

function parseStalePages(raw: unknown): LintStalePage[] {
  if (!Array.isArray(raw)) return [];
  const out: LintStalePage[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const page_id = typeof item.page_id === 'string' ? item.page_id : '';
    const title = typeof item.title === 'string' ? item.title : page_id;
    const last_updated = typeof item.last_updated === 'string' ? item.last_updated : '';
    if (page_id) out.push({ page_id, title, last_updated });
  }
  return out;
}

function parseMissingCrossRefs(raw: unknown): LintMissingCrossRef[] {
  if (!Array.isArray(raw)) return [];
  const out: LintMissingCrossRef[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const entity_text = typeof item.entity_text === 'string' ? item.entity_text : '';
    const mention_count = typeof item.mention_count === 'number' ? item.mention_count : 0;
    if (entity_text) out.push({ entity_text, mention_count });
  }
  return out;
}

function parseDeadProvenance(raw: unknown): LintDeadProvenance[] {
  if (!Array.isArray(raw)) return [];
  const out: LintDeadProvenance[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const provenance_id = typeof item.provenance_id === 'number' ? item.provenance_id : 0;
    const page_id = typeof item.page_id === 'string' ? item.page_id : '';
    const page_title = typeof item.page_title === 'string' ? item.page_title : page_id;
    const source_id = typeof item.source_id === 'string' ? item.source_id : '';
    if (page_id && source_id) out.push({ provenance_id, page_id, page_title, source_id });
  }
  return out;
}

function parseContradictions(raw: unknown): LintContradiction[] {
  if (!Array.isArray(raw)) return [];
  const out: LintContradiction[] = [];
  for (const item of raw) {
    if (!isRecord(item)) continue;
    const page_a_id = typeof item.page_a_id === 'string'
      ? item.page_a_id
      : typeof item.page_a === 'string'
        ? item.page_a
        : '';
    const page_b_id = typeof item.page_b_id === 'string'
      ? item.page_b_id
      : typeof item.page_b === 'string'
        ? item.page_b
        : '';
    const page_a_title = typeof item.page_a_title === 'string' ? item.page_a_title : page_a_id;
    const page_b_title = typeof item.page_b_title === 'string' ? item.page_b_title : page_b_id;
    const claim = typeof item.claim === 'string' ? item.claim : '';
    const severity = typeof item.severity === 'string' ? item.severity : 'minor';
    if (page_a_id && page_b_id && claim) {
      out.push({ page_a_id, page_a_title, page_b_id, page_b_title, claim, severity });
    }
  }
  return out;
}

/**
 * Parse lint_complete details or POST /api/wiki/lint-pass response.
 * Returns null for missing or malformed input.
 */
export function normalizeLintResult(raw: Record<string, unknown> | null): LintResult | null {
  if (!raw) return null;
  const run_duration_ms = typeof raw.run_duration_ms === 'number' ? raw.run_duration_ms : 0;
  return {
    orphan_pages: parseOrphanPages(raw.orphan_pages),
    stale_pages: parseStalePages(raw.stale_pages),
    missing_cross_refs: parseMissingCrossRefs(raw.missing_cross_refs),
    dead_provenance: parseDeadProvenance(raw.dead_provenance),
    contradictions: parseContradictions(raw.contradictions),
    run_duration_ms,
  };
}

/** Counts with fallback to legacy numeric fields in raw activity log rows. */
export function lintCounts(result: LintResult, raw?: Record<string, unknown> | null): LintCounts {
  const legacyOrphans = raw && typeof raw.orphan_pages === 'number' ? raw.orphan_pages : null;
  const legacyStale = raw && typeof raw.stale_pages === 'number' ? raw.stale_pages : null;
  const legacyDead = raw && typeof raw.dead_provenance === 'number' ? raw.dead_provenance : null;
  const legacyContra = raw && typeof raw.contradiction_count === 'number' ? raw.contradiction_count : null;

  return {
    orphans: result.orphan_pages.length > 0 ? result.orphan_pages.length : (legacyOrphans ?? 0),
    stale: result.stale_pages.length > 0 ? result.stale_pages.length : (legacyStale ?? 0),
    crossRefs: result.missing_cross_refs.length,
    deadProv: result.dead_provenance.length > 0 ? result.dead_provenance.length : (legacyDead ?? 0),
    contradictions: result.contradictions.length > 0 ? result.contradictions.length : (legacyContra ?? 0),
  };
}

export function legacyCountHint(count: number, arrayLen: number): boolean {
  return count > 0 && arrayLen === 0;
}
