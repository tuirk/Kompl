/**
 * The match step re-checks stored triage failures (lib/compile/triage-recheck.ts).
 *
 * Only while the re-check switch is on, oldest pair first, at most
 * MAX_TRIAGE_RECHECKS_PER_COMPILE triage calls per compile. A verdict is kept
 * on the pair for this session and joins the step's matches; a failure
 * counts an attempt and the pair is dropped at MAX_TRIAGE_ATTEMPTS; a daily
 * cost ceiling refusal counts none and ends the re-checks for this compile.
 * Pairs whose source or page is archived, or that are already linked, go
 * without a call. One activity row per compile says what happened.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as matchPOST } from '../app/api/compile/match/route';
import { POST as planPOST } from '../app/api/compile/plan/route';
import { getEventDef, type FeedActivityRow } from '../lib/activity-events';
import {
  MAX_TRIAGE_ATTEMPTS,
  MAX_TRIAGE_RECHECKS_PER_COMPILE,
  setTriageRecheckEnabled,
} from '../lib/triage-rechecks';
import { setupTestDb, seedSource, seedPage, seedProvenance, type TestDbHandle } from './helpers/test-db';
import { seedStoredPair, status, storedPairs, stubFetch, verdict } from './helpers/triage-stub';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

const SESSION = 'sess-now';

function post(path: string, body: Record<string, unknown>): Request {
  return new Request(`http://test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

interface MatchResult {
  matches: Array<{ source_id: string; page_id: string; page_title: string; decision: string; reason: string }>;
  stats: Record<string, number>;
}

async function runMatch(extra: Record<string, unknown> = {}): Promise<MatchResult> {
  const res = await matchPOST(post('/api/compile/match', { session_id: SESSION, canonical_entities: [], ...extra }));
  expect(res.status).toBe(200);
  return (await res.json()) as MatchResult;
}

/** A compiled source from an earlier session, with readable text. */
function earlierSource(title = 'Earlier article'): string {
  return seedSource(handle!.db, {
    title,
    onboarding_session_id: 'sess-earlier',
    compile_status: 'active',
    raw_markdown: `gamma ${title} ${'z'.repeat(600)}`,
  });
}

/** This session's own source, with no TF-IDF candidates. */
function sessionSource(): string {
  return seedSource(handle!.db, {
    onboarding_session_id: SESSION,
    compile_status: 'extracted',
    raw_markdown: `delta ${'d'.repeat(600)}`,
  });
}

function recheckRows(): Array<Record<string, unknown>> {
  return (
    handle!.db
      .prepare(`SELECT details FROM activity_log WHERE action_type = 'match_triage_rechecked'`)
      .all() as Array<{ details: string }>
  ).map((r) => JSON.parse(r.details) as Record<string, unknown>);
}

describe('switch off', () => {
  it('makes no call and leaves stored pairs as they are', async () => {
    handle = setupTestDb();
    const page_id = seedPage(handle.db, { title: 'Bitcoin', page_type: 'entity' });
    const source_id = earlierSource();
    sessionSource();
    seedStoredPair(handle.db, { source_id, page_id, attempts: 1 });
    const stub = stubFetch({ triage: { Bitcoin: verdict('update') } });

    const data = await runMatch();

    expect(stub.triaged).toEqual([]);
    expect(storedPairs(handle.db)).toEqual([expect.objectContaining({ source_id, page_id, attempts: 1, verdict: null })]);
    expect(data.stats).toMatchObject({ rechecked: 0, recheck_answered: 0, recheck_failed: 0, recheck_dropped: 0 });
    expect(recheckRows()).toEqual([]);
  });
});

describe('switch on', () => {
  it('re-checks the oldest pairs first, up to the cap per compile', async () => {
    handle = setupTestDb();
    setTriageRecheckEnabled(true);
    sessionSource();
    const total = MAX_TRIAGE_RECHECKS_PER_COMPILE + 2;
    const triage: Record<string, () => Response> = {};
    for (let i = 0; i < total; i++) {
      const title = `Page ${String(i).padStart(2, '0')}`;
      const page_id = seedPage(handle.db, { title, page_type: 'entity' });
      // Stored newest first, so insertion order is not the answer.
      const day = String(28 - i).padStart(2, '0');
      seedStoredPair(handle.db, { source_id: earlierSource(`Article ${i}`), page_id, first_failed_at: `2026-09-${day} 10:00:00` });
      triage[title] = verdict('skip');
    }
    const stub = stubFetch({ triage });

    const data = await runMatch();

    expect(stub.triaged).toHaveLength(MAX_TRIAGE_RECHECKS_PER_COMPILE);
    // Oldest = highest index (earliest day).
    const expected = Array.from({ length: MAX_TRIAGE_RECHECKS_PER_COMPILE }, (_, k) => `Page ${String(total - 1 - k).padStart(2, '0')}`);
    expect(stub.triaged).toEqual(expected);
    expect(data.stats).toMatchObject({ rechecked: MAX_TRIAGE_RECHECKS_PER_COMPILE, recheck_answered: MAX_TRIAGE_RECHECKS_PER_COMPILE });
    const unchecked = storedPairs(handle.db).filter((r) => r.verdict === null);
    expect(unchecked).toHaveLength(2);
  });

  it('keeps a verdict on the pair for this session and hands it to plan like a triage verdict', async () => {
    handle = setupTestDb();
    setTriageRecheckEnabled(true);
    const page_id = seedPage(handle.db, { title: 'Bitcoin', page_type: 'concept', summary: 'About Bitcoin' });
    const source_id = earlierSource();
    sessionSource();
    seedStoredPair(handle.db, { source_id, page_id });
    stubFetch({ triage: { Bitcoin: verdict('update', 'new figures') } });

    const data = await runMatch();

    expect(data.matches).toEqual([{ source_id, page_id, page_title: 'Bitcoin', decision: 'update', reason: 'new figures' }]);
    expect(storedPairs(handle.db)).toEqual([
      expect.objectContaining({ verdict: 'update', verdict_reason: 'new figures', verdict_session_id: SESSION }),
    ]);

    const res = await planPOST(post('/api/compile/plan', { session_id: SESSION, canonical_entities: [], matches: data.matches }));
    expect(res.status).toBe(200);
    const plans = handle.db
      .prepare(`SELECT action, page_type, source_ids FROM page_plans WHERE session_id = ? AND existing_page_id = ?`)
      .all(SESSION, page_id);
    expect(plans).toEqual([{ action: 'update', page_type: 'concept', source_ids: JSON.stringify([source_id]) }]);
  });

  it('hands this session’s stored verdicts to a re-plan without a new call', async () => {
    handle = setupTestDb();
    const page_id = seedPage(handle.db, { title: 'Bitcoin', page_type: 'entity' });
    const source_id = earlierSource();
    sessionSource();
    seedStoredPair(handle.db, { source_id, page_id, verdict: 'skip', verdict_reason: 'nothing new', verdict_session_id: SESSION });
    const stub = stubFetch({});

    // Even with the switch off: the answer was already paid for.
    const data = await runMatch();

    expect(stub.triaged).toEqual([]);
    expect(data.matches).toEqual([{ source_id, page_id, page_title: 'Bitcoin', decision: 'skip', reason: 'nothing new' }]);
    expect(data.stats.rechecked).toBe(0);
  });

  it('logs a contradiction with the source’s details, though it is from an earlier session', async () => {
    handle = setupTestDb();
    setTriageRecheckEnabled(true);
    const page_id = seedPage(handle.db, { title: 'Bitcoin', page_type: 'entity' });
    const source_id = earlierSource('Old article');
    sessionSource();
    seedStoredPair(handle.db, { source_id, page_id });
    stubFetch({ triage: { Bitcoin: verdict('contradiction', 'says otherwise') } });
    const data = await runMatch();

    await planPOST(post('/api/compile/plan', { session_id: SESSION, canonical_entities: [], matches: data.matches }));

    const row = handle.db
      .prepare(`SELECT details FROM activity_log WHERE action_type = 'page_contradiction_detected'`)
      .get() as { details: string };
    expect(JSON.parse(row.details)).toMatchObject({ page_id, source_title: 'Old article', reason: 'says otherwise' });
  });

  it('counts a failed re-check as an attempt and drops the pair at the maximum', async () => {
    handle = setupTestDb();
    setTriageRecheckEnabled(true);
    const keep = seedPage(handle.db, { title: 'Keep', page_type: 'entity' });
    const drop = seedPage(handle.db, { title: 'Drop', page_type: 'entity' });
    sessionSource();
    seedStoredPair(handle.db, { source_id: earlierSource('A'), page_id: keep, attempts: 1, first_failed_at: '2026-09-01 10:00:00' });
    seedStoredPair(handle.db, {
      source_id: earlierSource('B'),
      page_id: drop,
      attempts: MAX_TRIAGE_ATTEMPTS - 1,
      first_failed_at: '2026-09-02 10:00:00',
    });
    stubFetch({ triage: { Keep: status(500, 'boom'), Drop: status(429, 'llm_rate_limited') } });

    const data = await runMatch();

    expect(storedPairs(handle.db)).toEqual([
      expect.objectContaining({ page_id: keep, attempts: 2, reason: 'triage_error', session_id: SESSION, verdict: null }),
    ]);
    expect(data.matches).toEqual([]);
    expect(data.stats).toMatchObject({ rechecked: 2, recheck_answered: 0, recheck_failed: 1, recheck_dropped: 1 });
    const [row] = recheckRows();
    expect(row).toMatchObject({ session_id: SESSION, rechecked: 2, answered: 0, failed: 1, gave_up: 1, dropped: 1 });
    expect(row.examples).toEqual([expect.objectContaining({ source_title: 'B', page_title: 'Drop', outcome: 'gave_up' })]);
  });

  it('keeps a pair the daily cost ceiling refused, counts no attempt and stops re-checking', async () => {
    handle = setupTestDb();
    setTriageRecheckEnabled(true);
    const first = seedPage(handle.db, { title: 'First', page_type: 'entity' });
    const second = seedPage(handle.db, { title: 'Second', page_type: 'entity' });
    sessionSource();
    seedStoredPair(handle.db, { source_id: earlierSource('A'), page_id: first, attempts: 2, first_failed_at: '2026-09-01 10:00:00' });
    seedStoredPair(handle.db, { source_id: earlierSource('B'), page_id: second, attempts: 1, first_failed_at: '2026-09-02 10:00:00' });
    const stub = stubFetch({ triage: { First: status(503, 'daily_cost_ceiling'), Second: verdict('skip') } });

    const data = await runMatch();

    expect(stub.triaged).toEqual(['First']);
    const rows = storedPairs(handle.db);
    expect(rows).toEqual([
      expect.objectContaining({ page_id: first, attempts: 2, reason: 'daily_cost_ceiling', verdict: null }),
      expect.objectContaining({ page_id: second, attempts: 1, verdict: null }),
    ]);
    expect(data.stats).toMatchObject({ rechecked: 1, recheck_failed: 1, recheck_dropped: 0 });
    expect(recheckRows()[0]).toMatchObject({ cost_ceiling: 1 });
  });

  it('drops archived and already linked pairs without a call, and leaves sources not yet compiled waiting', async () => {
    handle = setupTestDb();
    setTriageRecheckEnabled(true);
    const linkedPage = seedPage(handle.db, { title: 'Linked', page_type: 'entity' });
    const archivedSourcePage = seedPage(handle.db, { title: 'ArchivedSource', page_type: 'entity' });
    const archivedPage = seedPage(handle.db, { title: 'ArchivedPage', page_type: 'entity' });
    const waitingPage = seedPage(handle.db, { title: 'Waiting', page_type: 'entity' });
    sessionSource();

    const linked = earlierSource('Linked source');
    seedProvenance(handle.db, linkedPage, linked, 'updated');
    seedStoredPair(handle.db, { source_id: linked, page_id: linkedPage });

    const archived = earlierSource('Archived source');
    handle.db.prepare(`UPDATE sources SET status = 'archived' WHERE source_id = ?`).run(archived);
    seedStoredPair(handle.db, { source_id: archived, page_id: archivedSourcePage });

    // Every source behind this page is archived.
    const behind = earlierSource('Behind');
    seedProvenance(handle.db, archivedPage, behind, 'created');
    handle.db.prepare(`UPDATE sources SET status = 'archived' WHERE source_id = ?`).run(behind);
    seedStoredPair(handle.db, { source_id: earlierSource('Live'), page_id: archivedPage });

    const pending = seedSource(handle.db, { onboarding_session_id: 'sess-other', compile_status: 'extracted', raw_markdown: 'x'.repeat(600) });
    seedStoredPair(handle.db, { source_id: pending, page_id: waitingPage });

    // Compiled, but its text file is gone.
    const unreadable = seedSource(handle.db, { onboarding_session_id: 'sess-earlier', compile_status: 'active' });
    seedStoredPair(handle.db, { source_id: unreadable, page_id: seedPage(handle.db, { title: 'Unreadable', page_type: 'entity' }) });

    const stub = stubFetch({});
    const data = await runMatch();

    expect(stub.triaged).toEqual([]);
    expect(storedPairs(handle.db).map((r) => r.page_id)).toEqual([waitingPage]);
    expect(data.stats).toMatchObject({ rechecked: 0, recheck_dropped: 4 });
    expect(recheckRows()[0]).toMatchObject({ rechecked: 0, dropped: 4, gave_up: 0, waiting: 1 });
  });

  it('does nothing with stored pairs when plan will not use this step', async () => {
    handle = setupTestDb();
    setTriageRecheckEnabled(true);
    const page_id = seedPage(handle.db, { title: 'Bitcoin', page_type: 'entity' });
    const source_id = earlierSource();
    sessionSource();
    seedStoredPair(handle.db, { source_id, page_id });
    seedStoredPair(handle.db, {
      source_id: earlierSource('Other'),
      page_id: seedPage(handle.db, { title: 'Other', page_type: 'entity' }),
      verdict: 'update',
      verdict_session_id: SESSION,
    });
    const stub = stubFetch({ triage: { Bitcoin: verdict('update') } });

    const data = await runMatch({ will_plan: false });

    expect(stub.triaged).toEqual([]);
    expect(data.matches).toEqual([]);
    expect(storedPairs(handle.db)).toHaveLength(2);
  });
});

describe('activity feed', () => {
  const text = (node: unknown): string => {
    if (node === null || node === undefined || typeof node === 'boolean') return '';
    if (typeof node === 'string' || typeof node === 'number') return String(node);
    if (Array.isArray(node)) return node.map(text).join('');
    return text((node as { props: { children?: unknown } }).props.children);
  };

  it('renders what the re-checks did', () => {
    const def = getEventDef('match_triage_rechecked');
    expect(def).not.toBeNull();
    const row: FeedActivityRow = {
      id: 1, timestamp: '2026-10-24 10:00:00', action_type: 'match_triage_rechecked', source_id: null, source_title: null,
      details: JSON.stringify({
        session_id: 's', rechecked: 4, answered: 2, failed: 1, cost_ceiling: 1, dropped: 2, gave_up: 1, waiting: 3,
        examples: [{ source_title: 'An article', page_title: 'Bitcoin', outcome: 'gave_up' }],
      }),
    };
    const content = def!.render(row);
    expect(text(content.primary)).toBe('4 earlier failed checks against existing pages run again');
    expect(text(content.secondary)).toBe(
      `2 answered · 1 failed again (1 hit the daily cost limit) · 1 given up after ${MAX_TRIAGE_ATTEMPTS} tries · 1 no longer needed · 3 still waiting · given up: An article → Bitcoin`,
    );
  });

  it('names dropped checks when none ran', () => {
    const def = getEventDef('match_triage_rechecked')!;
    const row: FeedActivityRow = {
      id: 2, timestamp: '2026-10-24 10:00:00', action_type: 'match_triage_rechecked', source_id: null, source_title: null,
      details: JSON.stringify({ session_id: 's', rechecked: 0, answered: 0, failed: 0, cost_ceiling: 0, dropped: 1, gave_up: 0, waiting: 0, examples: [] }),
    };
    expect(text(def.render(row).primary)).toBe('1 earlier failed check against existing pages dropped');
    expect(text(def.render(row).secondary)).toBe('1 no longer needed');
  });
});
