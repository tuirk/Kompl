/**
 * source_count correctness — compile/commit and approve-plan paths.
 *
 * Before this fix both paths unconditionally `UPDATE pages SET
 * source_count = sourceIds.length` inside their Phase 2 transaction. For
 * plans whose source_ids is NOT corpus-wide — Rule 1 source-summary title
 * collisions and Rule 6 match-triage updates (both use [single]) — this
 * clobbered the cumulative count left by insertPage's ON CONFLICT clause.
 *
 * Fix: derive source_count from COUNT(DISTINCT source_id) over provenance
 * AFTER the insertProvenance loop. This is the ground truth and handles
 * the created+updated duplicate rows provenance allows.
 *
 * Invariant the fix upholds: after any page-writing commit transaction,
 *   pages.source_count == (SELECT COUNT(DISTINCT source_id) FROM provenance
 *                          WHERE page_id = <this page>)
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as commitPOST } from '../app/api/compile/commit/route';
import { commitSinglePlan } from '../lib/approve-plan';
import {
  setupTestDb,
  seedSource,
  seedPage,
  seedPagePlan,
  seedCompileProgress,
  type TestDbHandle,
} from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

// Stub fetch for the nlp-service Phase 3a flush so tests exercise only the DB.
function stubFetchOk(): void {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () =>
      new Response(
        JSON.stringify({ current_path: '/tmp/fake', previous_path: null }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      )
    )
  );
}

function seedProvenance(
  db: TestDbHandle['db'],
  page_id: string,
  source_id: string,
  contribution_type: string = 'created'
): void {
  db.prepare(
    `INSERT INTO provenance (source_id, page_id, content_hash, contribution_type)
     VALUES (?, ?, 'seed-hash', ?)`
  ).run(source_id, page_id, contribution_type);
}

const DRAFT_MD = (title: string): string => {
  const body = 'body '.repeat(200); // ≈ 1000 chars — clears Gate 2
  return `---\ntitle: "${title}"\npage_type: entity\ncategory: Test\nsummary: "t"\n---\n\n${body}`;
};

describe('source_count — compile/approve derives from provenance', () => {
  it('approve-plan: update plan with ONE new source on a page with cumulative 5 → final count = 6', async () => {
    handle = setupTestDb();

    // Existing page with 5 distinct contributing sources in provenance.
    const page_id = seedPage(handle.db, {
      page_id: 'page-accum',
      title: 'Accum',
      page_type: 'entity',
    });
    for (let i = 1; i <= 5; i++) {
      const sid = seedSource(handle.db, { source_id: `s${i}` });
      seedProvenance(handle.db, page_id, sid);
    }
    handle.db
      .prepare('UPDATE pages SET source_count = 5 WHERE page_id = ?')
      .run(page_id);

    // New session source + Rule 6-style update plan with source_ids = [s6].
    const session_id = 'sess-approve-update';
    const newSourceId = seedSource(handle.db, {
      source_id: 's6',
      onboarding_session_id: session_id,
    });

    const plan_id = seedPagePlan(handle.db, {
      session_id,
      title: 'Accum',
      page_type: 'entity',
      action: 'update',
      existing_page_id: page_id,
      source_ids: [newSourceId],
      draft_status: 'pending_approval',
      draft_content: DRAFT_MD('Accum'),
    });

    stubFetchOk();
    const result = await commitSinglePlan(plan_id);
    expect(result.ok).toBe(true);

    const row = handle.db
      .prepare('SELECT source_count FROM pages WHERE page_id = ?')
      .get(page_id) as { source_count: number };
    expect(row.source_count).toBe(6);

    // Invariant check: matches DISTINCT over provenance.
    const truth = handle.db
      .prepare(
        'SELECT COUNT(DISTINCT source_id) AS n FROM provenance WHERE page_id = ?'
      )
      .get(page_id) as { n: number };
    expect(row.source_count).toBe(truth.n);
  });

  it('compile/commit: update plan with overlapping source_ids → DISTINCT count, not raw length', async () => {
    handle = setupTestDb();
    const session_id = 'sess-commit-overlap';
    seedCompileProgress(handle.db, session_id);

    // Existing page with 2 sources already in provenance.
    const page_id = seedPage(handle.db, {
      page_id: 'page-overlap',
      title: 'Overlap',
      page_type: 'entity',
    });
    const s1 = seedSource(handle.db, {
      source_id: 's1',
      onboarding_session_id: session_id,
      raw_markdown: 'x'.repeat(600),
    });
    const s2 = seedSource(handle.db, {
      source_id: 's2',
      onboarding_session_id: session_id,
      raw_markdown: 'x'.repeat(600),
    });
    seedProvenance(handle.db, page_id, s1);
    seedProvenance(handle.db, page_id, s2);
    handle.db
      .prepare('UPDATE pages SET source_count = 2 WHERE page_id = ?')
      .run(page_id);

    // Add a third session source.
    const s3 = seedSource(handle.db, {
      source_id: 's3',
      onboarding_session_id: session_id,
      raw_markdown: 'x'.repeat(600),
    });

    // Rule 2-style update plan: corpus-wide source_ids overlap [s1,s2,s3].
    seedPagePlan(handle.db, {
      session_id,
      title: 'Overlap',
      page_type: 'entity',
      action: 'update',
      existing_page_id: page_id,
      source_ids: [s1, s2, s3],
      draft_status: 'crossreffed',
      draft_content: DRAFT_MD('Overlap'),
    });

    stubFetchOk();
    const res = await commitPOST(
      new Request('http://test/api/compile/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id }),
      })
    );
    expect(res.status).toBe(200);

    const row = handle.db
      .prepare('SELECT source_count FROM pages WHERE page_id = ?')
      .get(page_id) as { source_count: number };
    // Three distinct sources contribute. Pre-fix would have been raw
    // sourceIds.length = 3 too — coincidentally correct on THIS case —
    // but the assertion pins the invariant regardless.
    expect(row.source_count).toBe(3);

    const truth = handle.db
      .prepare(
        'SELECT COUNT(DISTINCT source_id) AS n FROM provenance WHERE page_id = ?'
      )
      .get(page_id) as { n: number };
    expect(row.source_count).toBe(truth.n);
  });

  it('compile/commit: create plan with three fresh sources → final count = 3', async () => {
    handle = setupTestDb();
    const session_id = 'sess-commit-create';
    seedCompileProgress(handle.db, session_id);

    const s1 = seedSource(handle.db, {
      source_id: 'c1',
      onboarding_session_id: session_id,
      raw_markdown: 'x'.repeat(600),
    });
    const s2 = seedSource(handle.db, {
      source_id: 'c2',
      onboarding_session_id: session_id,
      raw_markdown: 'x'.repeat(600),
    });
    const s3 = seedSource(handle.db, {
      source_id: 'c3',
      onboarding_session_id: session_id,
      raw_markdown: 'x'.repeat(600),
    });

    seedPagePlan(handle.db, {
      session_id,
      title: 'FreshPage',
      page_type: 'entity',
      action: 'create',
      existing_page_id: null,
      source_ids: [s1, s2, s3],
      draft_status: 'crossreffed',
      draft_content: DRAFT_MD('FreshPage'),
    });

    stubFetchOk();
    const res = await commitPOST(
      new Request('http://test/api/compile/commit', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id }),
      })
    );
    expect(res.status).toBe(200);

    const row = handle.db
      .prepare(`SELECT source_count FROM pages WHERE title = 'FreshPage'`)
      .get() as { source_count: number } | undefined;
    expect(row).toBeDefined();
    expect(row!.source_count).toBe(3);
  });
});
