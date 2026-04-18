/**
 * POST /api/compile/crossref
 *
 * Part 2c-i — Step 6: Cross-Reference.
 *
 * Deterministic [[wikilink]] injection over all drafted pages in the session
 * plus the existing wiki. No LLM call — replaces the prior Gemini-backed
 * crossref that failed to scale past ~20 pages (cost, latency, and
 * HeadersTimeoutError cascades under large batches). Matches the pattern
 * used by MediaWiki's LinkTitles, Obsidian's Automatic Linker, Logseq, and
 * Roam.
 *
 * Contradiction detection was also part of the old flow; the committed
 * sessions we've seen showed zero contradictions found, so it's dropped here.
 * Can be reintroduced as a targeted job (pages sharing ≥2 entities) if ever
 * needed.
 *
 * Request:  { session_id: string }
 * Response: { session_id, pages_updated, wikilinks_added, contradictions_found: 0 }
 */

import { NextResponse } from 'next/server';

import {
  getAliases,
  getAllPages,
  getPagePlansByStatus,
  updatePlanCrossref,
} from '../../../../lib/db';
import { injectWikilinks, type WikilinkTarget } from '../../../../lib/wikilink-injector';

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

  try {
    const draftedPlans = getPagePlansByStatus(session_id, 'drafted');

    if (draftedPlans.length === 0) {
      return NextResponse.json(
        { session_id, pages_updated: 0, wikilinks_added: 0, contradictions_found: 0 },
        { status: 200 }
      );
    }

    // Targets for wikilinks: (a) every in-session drafted page, (b) every
    // committed page in the existing wiki. Alias table maps surface form →
    // canonical name from the resolve step; treat aliases that match a page
    // title as surface variants of that page.
    const existingPages = getAllPages();
    const canonicalTitles = new Set<string>();
    const targetByTitle = new Map<string, WikilinkTarget>();

    const addTarget = (title: string | null | undefined) => {
      if (!title) return;
      canonicalTitles.add(title);
      if (!targetByTitle.has(title)) {
        targetByTitle.set(title, { title, aliases: [] });
      }
    };

    for (const plan of draftedPlans) {
      if (plan.draft_content !== null) addTarget(plan.title);
    }
    for (const p of existingPages) addTarget(p.title);

    // Attach aliases whose canonical_name matches one of our target titles.
    const aliases = getAliases();
    for (const row of aliases) {
      if (!canonicalTitles.has(row.canonical_name)) continue;
      const target = targetByTitle.get(row.canonical_name);
      if (target) target.aliases!.push(row.alias);
    }

    const targets = [...targetByTitle.values()];

    let pagesUpdated = 0;
    let wikilinksAdded = 0;

    for (const plan of draftedPlans) {
      if (plan.draft_content === null) continue;

      // A page must not self-link. Build a per-page target set that excludes
      // the page's own title and any aliases whose canonical is the page's
      // own title.
      const pageTargets: WikilinkTarget[] = targets
        .filter((t) => t.title !== plan.title)
        .map((t) => ({ title: t.title, aliases: t.aliases ?? [] }));

      const { markdown, linksAdded } = injectWikilinks(plan.draft_content, pageTargets);
      updatePlanCrossref(plan.plan_id, markdown);
      pagesUpdated += 1;
      wikilinksAdded += linksAdded;
    }

    return NextResponse.json(
      {
        session_id,
        pages_updated: pagesUpdated,
        wikilinks_added: wikilinksAdded,
        contradictions_found: 0,
      },
      { status: 200 }
    );
  } catch (err) {
    console.error('[crossref]', err);
    const msg = err instanceof Error ? err.message : String(err);
    return NextResponse.json({ error: msg }, { status: 500 });
  }
}
