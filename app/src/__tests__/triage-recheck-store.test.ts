/**
 * POST /api/compile/match keeps every triage call that gave no verdict as a
 * stored (source, page) pair (triage_rechecks), so a later compile can check
 * it again. A verdict for a stored pair removes it, but only when plan will
 * use this match step's answers. Deleting the source or the page removes the
 * pair. The re-check switch is off by default, carried by the settings API
 * and never restored from a backup.
 */

import JSZip from 'jszip';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as matchPOST } from '../app/api/compile/match/route';
import { GET as exportGET } from '../app/api/export/route';
import { GET as settingsGET, POST as settingsPOST } from '../app/api/settings/route';
import { deletePage, deleteSource } from '../lib/db';
import { isBackedUpSetting } from '../lib/backup-settings';
import { getTriageRecheckEnabled, setTriageRecheckEnabled, TRIAGE_RECHECK_FLAG } from '../lib/triage-rechecks';
import { setupTestDb, seedSource, seedPage, type TestDbHandle } from './helpers/test-db';
import { seedStoredPair, status, storedPairs, stubFetch, verdict } from './helpers/triage-stub';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

function post(path: string, body: Record<string, unknown>, headers: Record<string, string> = {}): Request {
  return new Request(`http://test${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...headers },
    body: JSON.stringify(body),
  });
}

async function runMatch(session_id: string, extra: Record<string, unknown> = {}) {
  const res = await matchPOST(post('/api/compile/match', { session_id, canonical_entities: [], ...extra }));
  expect(res.status).toBe(200);
  return (await res.json()) as { matches: Array<{ page_id: string; decision: string }>; stats: Record<string, number> };
}

/** One session source triaged against three pages: ceiling, error, skip. */
function seedSession(session_id: string) {
  const { db } = handle!;
  for (const [page_id, title] of [['p-ceiling', 'Ceiling'], ['p-error', 'Error'], ['p-skip', 'Skip']]) {
    seedPage(db, { page_id, title, page_type: 'entity', summary: `About ${title}` });
  }
  const source_id = seedSource(db, {
    onboarding_session_id: session_id,
    compile_status: 'extracted',
    raw_markdown: `alpha ${'x'.repeat(600)}`,
  });
  return source_id;
}

describe('a failed triage is stored', () => {
  it('keeps each failed pair with its cause; a verdict is not stored', async () => {
    handle = setupTestDb();
    const session_id = 'sess-store';
    const source_id = seedSession(session_id);
    stubFetch({
      candidates: { alpha: ['p-ceiling', 'p-error', 'p-skip'] },
      triage: { Ceiling: status(503, 'daily_cost_ceiling'), Error: status(500, 'boom'), Skip: verdict('skip') },
    });

    await runMatch(session_id);

    const rows = storedPairs(handle.db);
    expect(rows.map((r) => [r.page_id, r.reason, r.attempts, r.session_id, r.source_id])).toEqual(
      expect.arrayContaining([
        ['p-ceiling', 'daily_cost_ceiling', 0, session_id, source_id],
        ['p-error', 'triage_error', 1, session_id, source_id],
      ]),
    );
    expect(rows).toHaveLength(2);
    expect(rows.every((r) => r.verdict === null && r.first_failed_at && r.last_failed_at)).toBe(true);
  });

  it('counts a repeat failure as one more attempt, except a cost ceiling refusal', async () => {
    handle = setupTestDb();
    const session_id = 'sess-store-again';
    seedSession(session_id);
    stubFetch({
      candidates: { alpha: ['p-ceiling', 'p-error', 'p-skip'] },
      triage: { Ceiling: status(503, 'daily_cost_ceiling'), Error: status(429, 'llm_rate_limited'), Skip: verdict('skip') },
    });

    await runMatch(session_id);
    await runMatch(session_id);

    const byPage = Object.fromEntries(storedPairs(handle.db).map((r) => [r.page_id, r]));
    expect(byPage['p-ceiling']).toMatchObject({ attempts: 0, reason: 'daily_cost_ceiling' });
    expect(byPage['p-error']).toMatchObject({ attempts: 2, reason: 'llm_rate_limited' });
  });

  it('a verdict removes the stored pair when plan uses this step, and keeps it otherwise', async () => {
    handle = setupTestDb();
    const session_id = 'sess-store-verdict';
    const source_id = seedSession(session_id);
    seedStoredPair(handle.db, { source_id, page_id: 'p-skip', session_id });
    stubFetch({ candidates: { alpha: ['p-skip'] }, triage: { Skip: verdict('update') } });

    await runMatch(session_id, { will_plan: false });
    expect(storedPairs(handle.db).map((r) => r.page_id)).toEqual(['p-skip']);

    const data = await runMatch(session_id, { will_plan: true });
    expect(data.matches).toEqual([expect.objectContaining({ page_id: 'p-skip', decision: 'update' })]);
    expect(storedPairs(handle.db)).toEqual([]);
  });

  it('rejects a will_plan that is not a boolean', async () => {
    handle = setupTestDb();
    const res = await matchPOST(post('/api/compile/match', { session_id: 's', canonical_entities: [], will_plan: 'yes' }));
    expect(res.status).toBe(422);
  });
});

describe('a stored pair goes with its source or page', () => {
  it.each([
    ['page', (ids: { source_id: string; page_id: string }) => deletePage(ids.page_id)],
    ['source', (ids: { source_id: string; page_id: string }) => void deleteSource(ids.source_id)],
  ])('deleting the %s removes the pair', (_what, remove) => {
    handle = setupTestDb();
    const page_id = seedPage(handle.db, { title: 'Bitcoin' });
    const source_id = seedSource(handle.db, { compile_status: 'active' });
    const other = seedPage(handle.db, { title: 'Ethereum' });
    seedStoredPair(handle.db, { source_id, page_id });
    seedStoredPair(handle.db, { source_id: seedSource(handle.db, { compile_status: 'active' }), page_id: other });

    remove({ source_id, page_id });

    expect(storedPairs(handle.db).map((r) => r.page_id)).toEqual([other]);
  });
});

describe('the re-check switch', () => {
  it('is off by default and set through the settings API', async () => {
    handle = setupTestDb();
    expect(getTriageRecheckEnabled()).toBe(false);
    expect(((await (await settingsGET()).json()) as Record<string, unknown>).triage_recheck_enabled).toBe(false);

    expect((await settingsPOST(post('/api/settings', { triage_recheck_enabled: 'yes' }))).status).toBe(422);
    expect((await settingsPOST(post('/api/settings', { triage_recheck_enabled: true }))).status).toBe(200);
    expect(getTriageRecheckEnabled()).toBe(true);
    expect(((await (await settingsGET()).json()) as Record<string, unknown>).triage_recheck_enabled).toBe(true);
  });

  it('is not switched on from another site', async () => {
    handle = setupTestDb();
    const res = await settingsPOST(
      post('/api/settings', { triage_recheck_enabled: true }, { 'Sec-Fetch-Site': 'cross-site', Origin: 'https://evil.example' }),
    );
    expect(res.status).toBe(403);
    expect(getTriageRecheckEnabled()).toBe(false);
  });

  it('is never restored from a backup', () => {
    expect(TRIAGE_RECHECK_FLAG).toBe('triage_recheck_enabled');
    expect(isBackedUpSetting(TRIAGE_RECHECK_FLAG)).toBe(false);
  });

  it('backups carry neither the switch nor the stored pairs', async () => {
    handle = setupTestDb();
    setTriageRecheckEnabled(true);
    seedStoredPair(handle.db, { source_id: seedSource(handle.db, { compile_status: 'active' }), page_id: seedPage(handle.db, {}) });

    const res = await exportGET(new Request('http://test/api/export?format=kompl'));
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));

    const keys = (JSON.parse(await zip.file('db/settings.json')!.async('string')) as Array<{ key: string }>).map((s) => s.key);
    expect(keys).not.toContain(TRIAGE_RECHECK_FLAG);
    expect(Object.keys(zip.files).filter((f) => f.includes('triage'))).toEqual([]);
  });
});
