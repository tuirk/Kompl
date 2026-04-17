/**
 * POST /api/compile/crossref
 *
 * Part 2c-i — Step 6: Cross-Reference.
 *
 * Reads all page_plans for the session with draft_status='drafted'.
 * Sends them to /pipeline/crossref which:
 *   - Adds [[wikilinks]] between pages referencing each other
 *   - Flags contradictions with ⚠️ notes
 *   - Returns updated markdown for every page
 *
 * Context window management: if all pages exceed a reasonable size,
 * split into clusters based on related_plan_ids, then run a final
 * cross-cluster pass with titles+summaries only.
 *
 * Request:  { session_id: string }
 * Response: { session_id, pages_updated, wikilinks_added, contradictions_found }
 */

import { NextResponse } from 'next/server';

import { getPagePlansByStatus, updatePlanCrossref } from '../../../../lib/db';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

// Rough chars-per-page budget before we start batching (128k char context / page overhead)
const MAX_CHARS_PER_BATCH = 80_000;

interface CrossrefPageInput {
  plan_id: string;
  title: string;
  page_type: string;
  markdown: string;
}

interface CrossrefUpdatedPage {
  plan_id: string;
  markdown: string;
}

interface CrossrefContradiction {
  page_a: string;
  page_b: string;
  description: string;
}

interface CrossrefApiResponse {
  updated_pages: CrossrefUpdatedPage[];
  contradictions_found: CrossrefContradiction[];
}

async function callCrossref(pages: CrossrefPageInput[]): Promise<CrossrefApiResponse> {
  const res = await fetch(`${NLP_SERVICE_URL}/pipeline/crossref`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ pages }),
    signal: AbortSignal.timeout(300_000), // 5 min — large batches can be slow
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 429) throw Object.assign(new Error('llm_rate_limited'), { status: 429 });
    if (res.status === 503) throw Object.assign(new Error('daily_cost_ceiling'), { status: 503 });
    throw new Error(`crossref_failed: ${res.status} ${detail}`);
  }

  return res.json() as Promise<CrossrefApiResponse>;
}

// Count [[wikilinks]] in a markdown string
function countWikilinks(markdown: string): number {
  return (markdown.match(/\[\[[^\]]+\]\]/g) ?? []).length;
}

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

  const draftedPlans = getPagePlansByStatus(session_id, 'drafted');

  if (draftedPlans.length === 0) {
    return NextResponse.json(
      { session_id, pages_updated: 0, wikilinks_added: 0, contradictions_found: 0 },
      { status: 200 }
    );
  }

  const pages: CrossrefPageInput[] = draftedPlans
    .filter((p) => p.draft_content !== null)
    .map((p) => ({
      plan_id: p.plan_id,
      title: p.title,
      page_type: p.page_type,
      markdown: p.draft_content!,
    }));

  // Count existing wikilinks before crossref
  const wikiBefore = pages.reduce((n, p) => n + countWikilinks(p.markdown), 0);

  let allUpdated: CrossrefUpdatedPage[] = [];
  let allContradictions: CrossrefContradiction[] = [];

  // Batch if total content exceeds context budget
  const totalChars = pages.reduce((n, p) => n + p.markdown.length, 0);

  if (totalChars <= MAX_CHARS_PER_BATCH) {
    // Single call — all pages fit
    const result = await callCrossref(pages);
    allUpdated = result.updated_pages;
    allContradictions = result.contradictions_found;
  } else {
    // Split into clusters by related_plan_ids, then do a cross-cluster pass
    const planIdSet = new Set(pages.map((p) => p.plan_id));

    // Build clusters based on related_plan_ids
    const relatedMap = new Map<string, string[]>();
    for (const plan of draftedPlans) {
      const rel: string[] = plan.related_plan_ids ? JSON.parse(plan.related_plan_ids) : [];
      relatedMap.set(plan.plan_id, rel.filter((r) => planIdSet.has(r)));
    }

    // Simple greedy clustering: add to existing cluster if shares a relation
    const clusters: string[][] = [];
    const assigned = new Set<string>();

    for (const page of pages) {
      if (assigned.has(page.plan_id)) continue;
      const cluster = [page.plan_id];
      assigned.add(page.plan_id);
      const related = relatedMap.get(page.plan_id) ?? [];
      for (const r of related) {
        if (!assigned.has(r)) {
          cluster.push(r);
          assigned.add(r);
        }
      }
      clusters.push(cluster);
    }

    // Any unassigned pages get their own cluster
    for (const page of pages) {
      if (!assigned.has(page.plan_id)) {
        clusters.push([page.plan_id]);
        assigned.add(page.plan_id);
      }
    }

    // Run crossref per cluster
    const clusterResults = new Map<string, CrossrefUpdatedPage>();

    for (const cluster of clusters) {
      const clusterPages = pages.filter((p) => cluster.includes(p.plan_id));
      const result = await callCrossref(clusterPages);
      for (const up of result.updated_pages) {
        clusterResults.set(up.plan_id, up);
      }
      allContradictions.push(...result.contradictions_found);
    }

    // Cross-cluster pass: just titles + first 300 chars of each page (summary only)
    const summaryPages: CrossrefPageInput[] = pages.map((p) => ({
      plan_id: p.plan_id,
      title: p.title,
      page_type: p.page_type,
      markdown: (clusterResults.get(p.plan_id)?.markdown ?? p.markdown).slice(0, 300),
    }));

    const crossClusterResult = await callCrossref(summaryPages);
    allContradictions.push(...crossClusterResult.contradictions_found);

    // Build a lookup from the cross-cluster pass for wikilink injection.
    // Gemini may omit pages from its response — clusterResults is the source of
    // truth for full page content. Never fall back to cp.markdown (300-char
    // truncated) as that would store partial frontmatter and break rendering.
    const crossClusterByPlanId = new Map<string, CrossrefUpdatedPage>();
    for (const cp of crossClusterResult.updated_pages) {
      crossClusterByPlanId.set(cp.plan_id, cp);
    }

    // Merge: iterate clusterResults (complete) and apply any new cross-cluster wikilinks
    for (const [planId, existing] of clusterResults.entries()) {
      const cp = crossClusterByPlanId.get(planId);
      if (cp) {
        // Extract new [[wikilinks]] from cross-cluster result and inject into full content
        const newLinks = (cp.markdown.match(/\[\[[^\]]+\]\]/g) ?? []).filter(
          (lk) => !existing.markdown.includes(lk)
        );
        if (newLinks.length > 0) {
          existing.markdown += `\n\n## See Also\n\n${newLinks.join('\n\n')}`;
        }
      }
      allUpdated.push(existing);
    }
  }

  // Persist crossreffed content
  for (const up of allUpdated) {
    updatePlanCrossref(up.plan_id, up.markdown);
  }

  const wikilinksBefore = wikiBefore;
  const wikilinksAfter = allUpdated.reduce((n, p) => n + countWikilinks(p.markdown), 0);

  return NextResponse.json(
    {
      session_id,
      pages_updated: allUpdated.length,
      wikilinks_added: Math.max(0, wikilinksAfter - wikilinksBefore),
      contradictions_found: allContradictions.length,
    },
    { status: 200 }
  );
}
