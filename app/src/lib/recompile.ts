/**
 * recompilePage — re-draft a wiki page from its remaining sources.
 *
 * Called by DELETE /api/sources/[source_id] when a deleted source contributed
 * to a page that still has other sources. Instead of just decrementing
 * source_count (which leaves stale content), we re-draft the page using only
 * the remaining sources and commit the result.
 *
 * Flow:
 *   Phase 1 (async) — read remaining sources, call /pipeline/draft-page,
 *                      call /storage/write-page
 *   Phase 2 (sync)  — db.transaction: update pages + FTS5
 *   Phase 3 (f&f)   — vector upsert
 *
 * Throws on draft or write failure — caller catches and falls back to
 * decrementPageSourceCount so the source deletion still completes.
 */

import {
  getDb,
  getPage,
  getProvenanceForPage,
  getSource,
  readRawMarkdown,
  archivePage,
  updatePageContent,
  setPendingContent,
  clearPendingContent,
  getCategoryGroups,
  getPageTitleMap,
} from './db';
import { syncPageWikilinks } from './wikilinks';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

interface SourceContent {
  source_id: string;
  title: string;
  markdown: string;
}

interface WritePageResult {
  current_path: string;
  previous_path: string | null;
}

async function callDraftPage(
  pageType: string,
  title: string,
  sourceContents: SourceContent[],
  existingCategories: string[]
): Promise<string> {
  const res = await fetch(`${NLP_SERVICE_URL}/pipeline/draft-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      page_type: pageType,
      title,
      source_contents: sourceContents,
      related_pages: [],
      existing_content: null,
      schema: null,
      existing_categories: existingCategories,
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

async function callWritePage(pageId: string, markdown: string): Promise<WritePageResult> {
  const res = await fetch(`${NLP_SERVICE_URL}/storage/write-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page_id: pageId, markdown }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`write_page_failed: ${res.status} ${detail}`);
  }

  return res.json() as Promise<WritePageResult>;
}

/**
 * Re-draft a page using only its remaining sources (post-deletion).
 *
 * Precondition: removeProvenanceForSource(removedSourceId) has already been
 * called, so getProvenanceForPage(pageId) returns only remaining sources.
 *
 * @param pageId         The page to recompile.
 * @param removedSourceId The source that was just deleted (for logging only —
 *                        its provenance rows are already gone).
 * @returns              `{ outcome: 'rewritten' }` on normal redraft, or
 *                       `{ outcome: 'archived' }` when the page was archived
 *                       because no sources remained. Caller uses this to log
 *                       the correct activity event and increment the right counter.
 * @throws               On draft or write failure. Caller must catch and fall back.
 */
export async function recompilePage(
  pageId: string,
  removedSourceId: string
): Promise<{ outcome: 'rewritten' | 'archived' }> {
  // ── Fetch page metadata ───────────────────────────────────────────────────
  const page = getPage(pageId);
  if (!page) {
    // Page disappeared between the outer check and here — silently done.
    // Treat as archived-equivalent: nothing to rewrite, nothing to count.
    return { outcome: 'archived' };
  }

  // ── Get remaining sources (provenance already pruned by caller) ───────────
  const remainingProvenance = getProvenanceForPage(pageId);

  if (remainingProvenance.length === 0) {
    // Edge case: all provenance removed between check and now.
    archivePage(pageId);
    return { outcome: 'archived' };
  }

  // ── Build source contents for re-drafting ─────────────────────────────────
  const sourceContents: SourceContent[] = [];
  for (const prov of remainingProvenance) {
    if (prov.source_id === removedSourceId) continue; // belt-and-suspenders
    const src = getSource(prov.source_id);
    if (!src) continue;
    const markdown = readRawMarkdown(prov.source_id);
    if (!markdown) continue;
    sourceContents.push({ source_id: prov.source_id, title: src.title, markdown });
  }

  if (sourceContents.length === 0) {
    // No readable source content — can't rebuild. Throw so caller falls back.
    throw new Error(`no_readable_sources for page ${pageId} after removing ${removedSourceId}`);
  }

  // ── Phase 1: call Gemini via NLP service ─────────────────────────────────
  const existingCategories = getCategoryGroups()
    .map((g) => g.category)
    .filter((c) => c !== 'Uncategorized');
  const newMarkdown = await callDraftPage(page.page_type, page.title, sourceContents, existingCategories);

  // ── Phase 2: sync transaction — update pages + setPendingContent + FTS5 ──
  // File is NOT written yet. pending_content stores markdown so the boot
  // reconciler can re-attempt the flush if Phase 3a crashes.
  const db = getDb();
  const newSourceCount = sourceContents.length;
  const expectedPath = `/data/pages/${pageId}.md.gz`;

  db.transaction(() => {
    updatePageContent(
      pageId,
      expectedPath,
      null, // previous_content_path set by clearPendingContent after Phase 3a
      newSourceCount
    );

    // Outbox: store markdown for Phase 3a flush + crash recovery.
    setPendingContent(pageId, newMarkdown);

    // FTS5 upsert: strip frontmatter before indexing
    const bodyForFts = newMarkdown.replace(/^---[\s\S]*?---\n*/m, '');
    db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(pageId);
    db.prepare(
      'INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)'
    ).run(pageId, page.title, bodyForFts);
  })();

  // ── Phase 3a (awaited): flush pending_content to disk via nlp-service ────
  // Throws on failure — caller catches and falls back to decrementPageSourceCount.
  const writeResult = await callWritePage(pageId, newMarkdown);
  clearPendingContent(pageId, writeResult.previous_path);

  // ── Phase 3c: sync page_links — clear stale wikilinks, insert current ones ─
  // Must run after Phase 3a so the new markdown is available in newMarkdown.
  // Wrapped in a transaction so a crash between DELETE and INSERT doesn't leave
  // partial/no wikilinks (boot reconciler covers pending_content, not page_links).
  syncPageWikilinks(getDb(), pageId, newMarkdown, getPageTitleMap());

  // ── Phase 3b: vector upsert — fire-and-forget ────────────────────────────
  void fetch(`${NLP_SERVICE_URL}/vectors/upsert`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      page_id: pageId,
      metadata: {
        title: page.title,
        page_type: page.page_type,
        category: page.category ?? '',
        source_count: newSourceCount,
      },
    }),
    signal: AbortSignal.timeout(30_000),
  }).catch(() => {});

  return { outcome: 'rewritten' };
}
