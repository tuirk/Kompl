/**
 * Gate 1 (compile/plan/route.ts) and Gate 2 (compile/commit/route.ts).
 *
 * Gate 1 — sources with raw markdown < min_source_chars become 'original-source'
 *          pages (raw passthrough, no LLM draft). Default 500.
 *
 * Gate 2 — drafts whose body length (post-frontmatter) < min_draft_chars are
 *          rejected at commit, logged as 'draft_too_thin'. Default 800.
 *          Original-source pages are exempt — they are intentional sub-threshold
 *          passthroughs and Gate 2 targets thin LLM drafts.
 *
 * Stage 22 covers Gate 2's *exemption* path end-to-end. These unit tests cover
 * Gate 2's *rejection* path and Gate 1's branching, neither of which had any
 * coverage before.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as planPOST } from '../app/api/compile/plan/route';
import { POST as commitPOST } from '../app/api/compile/commit/route';
import {
  setupTestDb,
  seedSource,
  seedExtraction,
  seedPagePlan,
  seedCompileProgress,
  type TestDbHandle,
} from './helpers/test-db';
import { setSetting } from '../lib/db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

function planRequest(session_id: string, body: object = {}): Request {
  return new Request('http://test/api/compile/plan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id, canonical_entities: [], ...body }),
  });
}

function commitRequest(session_id: string): Request {
  return new Request('http://test/api/compile/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id }),
  });
}

interface PlanResponse {
  pages: Array<{ title: string; page_type: string; action: string }>;
  stats: { total: number; original_sources: number; source_summaries: number };
}

interface CommitResponse {
  committed: number;
  failed: number;
  thin_drafts_skipped: number;
  pages_created: number;
  pages_updated: number;
}

// ─── Gate 1 ──────────────────────────────────────────────────────────────────

describe('Gate 1 — min_source_chars page-type assignment', () => {
  it('flags sources with no raw file as original-source', async () => {
    handle = setupTestDb();
    const session_id = 'sess-g1-nofile';
    seedSource(handle.db, {
      onboarding_session_id: session_id,
      compile_status: 'pending',
    });

    const res = await planPOST(planRequest(session_id));
    const body = (await res.json()) as PlanResponse;

    expect(body.pages).toHaveLength(1);
    expect(body.pages[0].page_type).toBe('original-source');
  });

  it('flags sources with raw markdown < min_source_chars (500) as original-source', async () => {
    handle = setupTestDb();
    const session_id = 'sess-g1-short';
    seedSource(handle.db, {
      onboarding_session_id: session_id,
      compile_status: 'pending',
      raw_markdown: 'x'.repeat(499),
    });

    const res = await planPOST(planRequest(session_id));
    const body = (await res.json()) as PlanResponse;

    expect(body.pages[0].page_type).toBe('original-source');
  });

  it('flags sources with raw markdown >= min_source_chars as source-summary', async () => {
    handle = setupTestDb();
    const session_id = 'sess-g1-long';
    seedSource(handle.db, {
      onboarding_session_id: session_id,
      compile_status: 'pending',
      raw_markdown: 'y'.repeat(500),
    });

    const res = await planPOST(planRequest(session_id));
    const body = (await res.json()) as PlanResponse;

    expect(body.pages[0].page_type).toBe('source-summary');
  });

  it('disables Gate 1 when min_source_chars = 0 — every source is source-summary', async () => {
    handle = setupTestDb();
    setSetting('min_source_chars', '0');
    const session_id = 'sess-g1-disabled';
    seedSource(handle.db, {
      source_id: 'tiny',
      onboarding_session_id: session_id,
      compile_status: 'pending',
      raw_markdown: 'x', // 1 char
    });
    seedSource(handle.db, {
      source_id: 'empty',
      onboarding_session_id: session_id,
      compile_status: 'pending',
      // no raw file at all
    });

    const res = await planPOST(planRequest(session_id));
    const body = (await res.json()) as PlanResponse;

    expect(body.stats.original_sources).toBe(0);
    expect(body.stats.source_summaries).toBe(2);
  });
});

// ─── Gate 2 ──────────────────────────────────────────────────────────────────

function mockNlpServiceFetch(): void {
  // Phase 3a (write-page) and Phase 3b (vector upsert) both POST to nlp-service.
  // Tests don't run nlp-service — return a synthetic "wrote the file" response.
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL) => {
      const u = url.toString();
      if (u.includes('/storage/write-page')) {
        return new Response(JSON.stringify({ current_path: '/data/pages/x.md.gz', previous_path: null }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }
      if (u.includes('/vectors/upsert')) {
        return new Response('{}', { status: 200 });
      }
      throw new Error(`unexpected fetch in test: ${u}`);
    })
  );
}

describe('Gate 2 — min_draft_chars enforcement at commit', () => {
  it('commits drafts that meet the threshold', async () => {
    handle = setupTestDb();
    mockNlpServiceFetch();
    const session_id = 'sess-g2-pass';
    const source_id = seedSource(handle.db, {
      onboarding_session_id: session_id,
      compile_status: 'in_progress',
    });
    seedCompileProgress(handle.db, session_id);
    seedPagePlan(handle.db, {
      session_id,
      page_type: 'entity',
      action: 'create',
      source_ids: [source_id],
      draft_status: 'crossreffed',
      draft_content: `---\ntitle: "Big"\n---\n${'b'.repeat(800)}`,
    });

    const res = await commitPOST(commitRequest(session_id));
    const body = (await res.json()) as CommitResponse;

    expect(body.committed).toBe(1);
    expect(body.thin_drafts_skipped).toBe(0);
  });

  it('rejects drafts whose body (post-frontmatter) is below the threshold', async () => {
    handle = setupTestDb();
    mockNlpServiceFetch();
    const session_id = 'sess-g2-thin';
    const source_id = seedSource(handle.db, {
      onboarding_session_id: session_id,
      compile_status: 'in_progress',
    });
    seedCompileProgress(handle.db, session_id);
    seedPagePlan(handle.db, {
      session_id,
      page_type: 'entity',
      action: 'create',
      source_ids: [source_id],
      draft_status: 'crossreffed',
      draft_content: `---\ntitle: "Tiny"\n---\nshort body`,
    });

    const res = await commitPOST(commitRequest(session_id));
    const body = (await res.json()) as CommitResponse;

    expect(body.committed).toBe(0);
    expect(body.thin_drafts_skipped).toBe(1);

    // The activity log entry is what /api/digest reads to surface thin drafts —
    // assert the action_type a downstream consumer would filter on.
    const activity = handle.db
      .prepare('SELECT action_type FROM activity_log WHERE source_id = ?')
      .get(source_id) as { action_type: string } | undefined;
    expect(activity?.action_type).toBe('draft_too_thin');
  });

  it('exempts original-source pages from Gate 2 (Stage 22 path)', async () => {
    handle = setupTestDb();
    mockNlpServiceFetch();
    const session_id = 'sess-g2-orig';
    const source_id = seedSource(handle.db, {
      onboarding_session_id: session_id,
      compile_status: 'in_progress',
    });
    seedCompileProgress(handle.db, session_id);
    seedPagePlan(handle.db, {
      session_id,
      page_type: 'original-source',
      action: 'create',
      source_ids: [source_id],
      draft_status: 'crossreffed',
      // 50 chars body — would be rejected if not for the exemption
      draft_content: `---\ntitle: "Tweet"\n---\nThis is a tiny tweet.`,
    });

    const res = await commitPOST(commitRequest(session_id));
    const body = (await res.json()) as CommitResponse;

    expect(body.committed).toBe(1);
    expect(body.thin_drafts_skipped).toBe(0);
  });

  it('disables Gate 2 when min_draft_chars = 0 — all non-empty drafts commit', async () => {
    handle = setupTestDb();
    mockNlpServiceFetch();
    setSetting('min_draft_chars', '0');
    const session_id = 'sess-g2-disabled';
    const source_id = seedSource(handle.db, {
      onboarding_session_id: session_id,
      compile_status: 'in_progress',
    });
    seedCompileProgress(handle.db, session_id);
    seedPagePlan(handle.db, {
      session_id,
      page_type: 'entity',
      action: 'create',
      source_ids: [source_id],
      draft_status: 'crossreffed',
      draft_content: `---\ntitle: "Tiny"\n---\nshort`,
    });

    const res = await commitPOST(commitRequest(session_id));
    const body = (await res.json()) as CommitResponse;

    expect(body.committed).toBe(1);
    expect(body.thin_drafts_skipped).toBe(0);
  });

  it('measures body length AFTER stripping frontmatter — large frontmatter does not save a thin body', async () => {
    handle = setupTestDb();
    mockNlpServiceFetch();
    const session_id = 'sess-g2-fm';
    const source_id = seedSource(handle.db, {
      onboarding_session_id: session_id,
      compile_status: 'in_progress',
    });
    seedCompileProgress(handle.db, session_id);
    // 2000-char frontmatter, 50-char body — total > 800 but body < 800.
    const fm = `---\ntitle: "T"\nnotes: "${'n'.repeat(2000)}"\n---\n`;
    seedPagePlan(handle.db, {
      session_id,
      page_type: 'entity',
      action: 'create',
      source_ids: [source_id],
      draft_status: 'crossreffed',
      draft_content: `${fm}body too short`,
    });

    const res = await commitPOST(commitRequest(session_id));
    const body = (await res.json()) as CommitResponse;

    expect(body.committed).toBe(0);
    expect(body.thin_drafts_skipped).toBe(1);
  });
});

// ─── Gate 3 (activation) ─────────────────────────────────────────────────────
// Sources that landed in a page plan but have no extractions row (extract step
// failed mid-session; downstream drafted from raw markdown) must NOT be marked
// compile_status='active'. Otherwise the source is stranded: recompile returns
// 409 source_already_compiled, and retry-failed re-runs but getSourcesBySession
// filters out 'active' rows, leaving the orchestrator with preludeSources=[]
// → silent "skipped (no sources)" no-op. Bug surfaced in live session
// 4a882b4d-... (2026-05-11) where a Gemini-truncated PDF extract left the
// source unrecoverable.

describe('Gate 3 — commit activates only sources with extractions', () => {
  it('skips activation for sources that drafted from raw markdown (no extractions row)', async () => {
    handle = setupTestDb();
    mockNlpServiceFetch();
    const session_id = 'sess-g3-partial';

    // Source A — extracted normally.
    const extracted_id = seedSource(handle.db, {
      source_id: 'src-extracted',
      onboarding_session_id: session_id,
      compile_status: 'in_progress',
    });
    seedExtraction(handle.db, { source_id: extracted_id });

    // Source B — extract failed; no extractions row, but it still landed in
    // a plan (Rule 1 in plan/route.ts builds a source-summary for every
    // session source regardless of extract status) and got drafted from raw
    // markdown.
    const stranded_id = seedSource(handle.db, {
      source_id: 'src-stranded',
      onboarding_session_id: session_id,
      compile_status: 'extracted',
    });

    seedCompileProgress(handle.db, session_id);

    seedPagePlan(handle.db, {
      session_id,
      title: 'Extracted Page',
      page_type: 'entity',
      action: 'create',
      source_ids: [extracted_id],
      draft_status: 'crossreffed',
      draft_content: `---\ntitle: "Extracted Page"\n---\n${'x'.repeat(900)}`,
    });
    seedPagePlan(handle.db, {
      session_id,
      title: 'Stranded Source Summary',
      page_type: 'source-summary',
      action: 'create',
      source_ids: [stranded_id],
      draft_status: 'crossreffed',
      draft_content: `---\ntitle: "Stranded Source Summary"\n---\n${'y'.repeat(900)}`,
    });

    const res = await commitPOST(commitRequest(session_id));
    const body = (await res.json()) as CommitResponse & { sources_activated: number };

    expect(body.committed).toBe(2);
    expect(body.sources_activated).toBe(1);

    const statuses = handle.db
      .prepare(
        `SELECT source_id, compile_status FROM sources
          WHERE source_id IN (?, ?)
          ORDER BY source_id`
      )
      .all(extracted_id, stranded_id) as Array<{ source_id: string; compile_status: string }>;

    const byId = new Map(statuses.map((r) => [r.source_id, r.compile_status]));
    expect(byId.get(extracted_id)).toBe('active');
    // Stranded source stays in its prior status (here 'extracted'), NOT 'active',
    // so /api/sources/[id]/recompile and /api/compile/retry-failed can re-attempt
    // it via getSourcesBySession (which filters out 'active'/'compiled').
    expect(byId.get(stranded_id)).toBe('extracted');
  });
});
