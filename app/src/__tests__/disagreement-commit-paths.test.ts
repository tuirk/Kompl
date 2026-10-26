/**
 * Every commit path writes the disagreements record from the committed
 * markdown inside its Phase 2 transaction (plan 3.4, CLAUDE.md rule 5):
 * the finding is in the database before the page file is written, and it
 * names the compile session that found it.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as commitPOST } from '../app/api/compile/commit/route';
import { commitSinglePlan } from '../lib/approve-plan';
import { getActivityCounts, seedCompileProgress, seedPagePlan, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';

const DRAFT = [
  '---',
  'title: "Hub"',
  'page_type: entity',
  'category: Test',
  'summary: "t"',
  '---',
  '',
  'body '.repeat(200),
  '',
  '### Disputed: launch year',
  '',
  `2013[^${A}] or 2015[^${B}].`,
].join('\n');

/** Answers the page write, noting how many findings the database held at that moment. */
function stubWrites(): { findingsAtWrite: number[] } {
  const seen = { findingsAtWrite: [] as number[] };
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) => {
      if (String(url).endsWith('/storage/write-page')) {
        seen.findingsAtWrite.push(
          (handle!.db.prepare('SELECT COUNT(*) AS n FROM disagreements').get() as { n: number }).n,
        );
      }
      return Response.json({ current_path: '/tmp/fake', previous_path: null });
    }),
  );
  return seen;
}

function seedPlan(session_id: string, status: string): string {
  const db = handle!.db;
  seedCompileProgress(db, session_id);
  seedSource(db, { source_id: A, onboarding_session_id: session_id });
  seedSource(db, { source_id: B, onboarding_session_id: session_id });
  return seedPagePlan(db, {
    session_id,
    title: 'Hub',
    page_type: 'entity',
    source_ids: [A, B],
    draft_status: status,
    draft_content: DRAFT,
    used_source_ids: [A, B],
  });
}

function findings() {
  return handle!.db.prepare('SELECT page_id, found_by, kind, topic, session_id FROM disagreements').all();
}

describe('the compile commit', () => {
  it('records the page text disputes before the file is written, with the session', async () => {
    handle = setupTestDb();
    seedPlan('sess-commit', 'crossreffed');
    const seen = stubWrites();

    const res = await commitPOST(
      new Request('http://test/api/compile/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: 'sess-commit' }),
      }),
    );
    expect(res.status).toBe(200);
    expect(seen.findingsAtWrite[0]).toBe(1);
    expect(findings()).toEqual([
      { page_id: expect.any(String), found_by: 'page_text', kind: 'disputed', topic: 'Launch year', session_id: 'sess-commit' },
    ]);
    expect(getActivityCounts(handle.db).page_dispute_recorded).toBe(1);
  });
});

describe('draft approval', () => {
  it('records the page text disputes in the approval transaction', async () => {
    handle = setupTestDb();
    const plan_id = seedPlan('sess-approve', 'pending_approval');
    const seen = stubWrites();

    expect((await commitSinglePlan(plan_id)).ok).toBe(true);
    expect(seen.findingsAtWrite[0]).toBe(1);
    expect(findings()).toMatchObject([{ found_by: 'page_text', kind: 'disputed', topic: 'Launch year' }]);
  });
});
