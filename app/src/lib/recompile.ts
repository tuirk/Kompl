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
} from './db';

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
  sourceContents: SourceContent[]
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
 * @throws               On draft or write failure. Caller must catch and fall back.
 */
export async function recompilePage(pageId: string, removedSourceId: string): Promise<void> {
  // ── Fetch page metadata ───────────────────────────────────────────────────
  const page = getPage(pageId);
  if (!page) {
    // Page disappeared between the outer check and here — silently done.
    return;
  }

  // ── Get remaining sources (provenance already pruned by caller) ───────────
  const remainingProvenance = getProvenanceForPage(pageId);

  if (remainingProvenance.length === 0) {
    // Edge case: all provenance removed between check and now.
    archivePage(pageId);
    return;
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
  const newMarkdown = await callDraftPage(page.page_type, page.title, sourceContents);

  // ── Phase 1: write file (before sync transaction — orphan is harmless) ───
  const writeResult = await callWritePage(pageId, newMarkdown);

  // ── Phase 2: sync transaction — update pages + FTS5 ──────────────────────
  const db = getDb();
  const newSourceCount = sourceContents.length;

  db.transaction(() => {
    updatePageContent(
      pageId,
      writeResult.current_path,
      writeResult.previous_path,
      newSourceCount
    );

    // FTS5 upsert: strip frontmatter before indexing
    const bodyForFts = newMarkdown.replace(/^---[\s\S]*?---\n*/m, '');
    db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(pageId);
    db.prepare(
      'INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)'
    ).run(pageId, page.title, bodyForFts);
  })();

  // ── Phase 3: vector upsert — fire-and-forget ─────────────────────────────
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
}
