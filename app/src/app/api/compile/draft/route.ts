/**
 * POST /api/compile/draft
 *
 * Part 2c-i — Step 5: Draft Per Page.
 *
 * Reads all page_plans for the session with draft_status='planned'
 * (excluding provenance-only). Calls /pipeline/draft-page on the nlp-service
 * for each page, in layer order:
 *
 *   1. Source summaries (parallel, ≤5 concurrent)
 *   2. Entity pages (parallel)
 *   3. Concept pages (parallel)
 *   4. Comparison pages (needs entity drafts for context)
 *   5. Overview pages (needs all above)
 *
 * After each page is drafted, updates page_plans.draft_status = 'drafted'.
 *
 * Request:  { session_id: string }
 * Response: { session_id, drafted, failed, by_type }
 */

import { NextResponse } from 'next/server';

import {
  getExtractionsBySession,
  getPagePlansByStatus,
  readRawMarkdown,
  updatePlanDraft,
  updatePlanStatus,
  getDb,
} from '../../../../lib/db';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';
const DRAFT_CONCURRENCY = 5;

// ── Types ────────────────────────────────────────────────────────────────────

interface SourceContent {
  source_id: string;
  title: string;
  markdown: string;
}

interface RelatedPage {
  title: string;
  type: string;
  summary: string;
}

async function callDraftPage(
  pageType: string,
  title: string,
  sourceContents: SourceContent[],
  relatedPages?: RelatedPage[],
  existingContent?: string,
  schema?: string
): Promise<string> {
  const res = await fetch(`${NLP_SERVICE_URL}/pipeline/draft-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      page_type: pageType,
      title,
      source_contents: sourceContents,
      related_pages: relatedPages ?? [],
      existing_content: existingContent ?? null,
      schema: schema ?? null,
    }),
    signal: AbortSignal.timeout(180_000), // 3 min — Gemini thinking can be slow
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 429) throw Object.assign(new Error('llm_rate_limited'), { status: 429 });
    if (res.status === 503) throw Object.assign(new Error('daily_cost_ceiling'), { status: 503 });
    throw new Error(`draft_page_failed: ${res.status} ${detail}`);
  }

  const data = (await res.json()) as { markdown: string };
  return data.markdown;
}

// Run an array of async tasks with limited concurrency
async function pLimit<T>(
  tasks: Array<() => Promise<T>>,
  limit: number
): Promise<Array<T | Error>> {
  const results: Array<T | Error> = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try {
        results[i] = await tasks[i]();
      } catch (e) {
        results[i] = e instanceof Error ? e : new Error(String(e));
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
  return results;
}

// ── Route handler ─────────────────────────────────────────────────────────────

export async function POST(request: Request) {
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  const { session_id } = rawBody as { session_id?: string };
  if (typeof session_id !== 'string' || !session_id.trim()) {
    return NextResponse.json({ error: 'session_id required' }, { status: 400 });
  }

  const db = getDb();

  // Get all sources for this session (for reading markdown)
  const sessionSources = db
    .prepare(
      `SELECT source_id, title, content_hash
         FROM sources
        WHERE onboarding_session_id = ?`
    )
    .all(session_id) as Array<{ source_id: string; title: string; content_hash: string }>;

  const sourceMap = new Map<string, { title: string; markdown: string | null }>();
  for (const src of sessionSources) {
    sourceMap.set(src.source_id, {
      title: src.title,
      markdown: readRawMarkdown(src.source_id),
    });
  }

  // Also get sources for other sessions referenced by entity page source_ids
  // (Not needed on first compile — all sources are in this session)

  // Get planned pages
  const plans = getPagePlansByStatus(session_id, 'planned').filter(
    (p) => p.action !== 'provenance-only'
  );

  if (plans.length === 0) {
    return NextResponse.json({ session_id, drafted: 0, failed: 0, by_type: {} }, { status: 200 });
  }

  // Load the schema if it exists (for context)
  let schema: string | undefined;
  try {
    const schemaRes = await fetch(`${NLP_SERVICE_URL}/storage/read-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/data/schema.md' }),
      signal: AbortSignal.timeout(5_000),
    }).catch(() => null);
    if (schemaRes?.ok) {
      const d = (await schemaRes.json()) as { content?: string };
      schema = d.content;
    }
  } catch {
    // schema is optional — first compile won't have it
  }

  // Layer order for drafting
  const LAYER_ORDER = ['source-summary', 'entity', 'concept', 'comparison', 'overview'] as const;

  let drafted = 0;
  let failed = 0;
  const byType: Record<string, number> = {};

  for (const layer of LAYER_ORDER) {
    const layerPlans = plans.filter((p) => p.page_type === layer);
    if (layerPlans.length === 0) continue;

    // Build context from already-drafted pages (for comparison/overview layers)
    const draftedPlans = db
      .prepare(
        `SELECT plan_id, title, page_type, draft_content
           FROM page_plans
          WHERE session_id = ? AND draft_status = 'drafted'`
      )
      .all(session_id) as Array<{ plan_id: string; title: string; page_type: string; draft_content: string | null }>;

    const draftedContext: RelatedPage[] = draftedPlans.map((dp) => {
      // Extract summary from frontmatter if present
      let summary = '';
      if (dp.draft_content) {
        const summaryMatch = dp.draft_content.match(/^summary:\s*["']?(.+?)["']?\s*$/m);
        if (summaryMatch) summary = summaryMatch[1];
      }
      return { title: dp.title, type: dp.page_type, summary };
    });

    const tasks = layerPlans.map((plan) => async () => {
      const sourceIds: string[] = JSON.parse(plan.source_ids);
      const sourceContents: SourceContent[] = sourceIds
        .map((sid) => {
          const s = sourceMap.get(sid);
          // For sources from other sessions, try to read from DB
          if (!s) {
            const dbSrc = db
              .prepare('SELECT source_id, title FROM sources WHERE source_id = ?')
              .get(sid) as { source_id: string; title: string } | undefined;
            if (!dbSrc) return null;
            const md = readRawMarkdown(sid);
            return md ? { source_id: sid, title: dbSrc.title, markdown: md } : null;
          }
          return s.markdown ? { source_id: sid, title: s.title, markdown: s.markdown } : null;
        })
        .filter((sc): sc is SourceContent => sc !== null);

      if (sourceContents.length === 0) {
        throw new Error(`no_readable_sources for plan ${plan.plan_id}`);
      }

      // Related pages: for overview/comparison, use already-drafted pages
      const relatedPlanIds: string[] = plan.related_plan_ids ? JSON.parse(plan.related_plan_ids) : [];
      const relatedPages: RelatedPage[] = draftedContext.filter((dp) => {
        // Include if it's a related plan or just generally relevant drafted content
        return relatedPlanIds.length === 0
          ? draftedContext.length <= 10  // include all if few
          : relatedPlanIds.some((rId) => {
              const rPlan = draftedPlans.find((d) => d.plan_id === rId);
              return rPlan?.title === dp.title;
            });
      });

      const markdown = await callDraftPage(
        plan.page_type,
        plan.title,
        sourceContents,
        relatedPages.length > 0 ? relatedPages : undefined,
        plan.draft_content ?? undefined, // existing content for 'update' action
        schema
      );

      updatePlanDraft(plan.plan_id, markdown);
      return plan.page_type;
    });

    const results = await pLimit(tasks, DRAFT_CONCURRENCY);

    for (let i = 0; i < results.length; i++) {
      const r = results[i];
      if (r instanceof Error) {
        failed++;
        updatePlanStatus(layerPlans[i].plan_id, 'failed');
      } else {
        drafted++;
        byType[r] = (byType[r] ?? 0) + 1;
      }
    }
  }

  return NextResponse.json({ session_id, drafted, failed, by_type: byType }, { status: 200 });
}
