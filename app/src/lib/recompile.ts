/**
 * recompilePage — re-draft a wiki page from its remaining sources.
 *
 * Called by DELETE /api/sources/[source_id] when a deleted source contributed
 * to a page that still has other sources. Instead of just decrementing
 * source_count (which leaves stale content), we re-draft the page using only
 * the remaining sources and commit the result.
 *
 * Flow (outbox, CLAUDE.md rule 5):
 *   Phase 1 (async)  — read remaining sources, call /pipeline/draft-page
 *   Phase 2 (sync)   — db.transaction: update pages + pending_content +
 *                      draft_rules marker + FTS5 + disagreements record
 *   Phase 3a (await) — /storage/write-page, then clearPendingContent
 *   Phase 3c         — page_links resync
 *   Phase 3b (f&f)   — vector refresh, retried like a compile's
 *
 * Throws when the page can't be redrafted (draft failure, no readable
 * sources) — the caller retries a temporary failure once, then archives the
 * page until a rewrite succeeds (lib/page-hold.ts). Once Phase 2 has
 * committed, the new text is the page: a failed file write is left to the
 * boot reconciler, as for every commit path, and does not throw.
 *
 * A page archived that way returns as its own type in the same Phase 2
 * transaction as its new text.
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
  getCompileModel,
  getPageTitleMap,
  getAllPages,
  readPageMarkdown,
} from './db';
import { syncPageWikilinks } from './wikilinks';
import { LONG_HTTP_AGENT } from './long-http-agent';
import { assignCitationLabels, labelsToStoredCitations, rewordLabelSubjects } from './citations';
import { normalizeFrontmatter, relatedLinkTargets, sourceOnlyTitles, tidyDraftLinks } from './draft-cleanup';
import { withSourceText } from './source-page-text';
import { CURRENT_DRAFT_RULES, isDraftedPage, setPageDraftRules } from './draft-rules';
import { removeEmptyContradictionSections } from './page-sections';
import { recordPageDisagreements } from './disagreements';
import { sourceDates, withSourceDate } from './source-dates';
import { upsertVectorWithRetry } from './vector-upsert';
import { draftPageType, releaseHeldPage } from './page-hold';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

interface SourceContent {
  source_id: string;
  title: string;
  markdown: string;
  /** "S1"-style label the page cites this source with (lib/citations.ts). */
  citation_label?: string;
  /** Publication date, else the day it was saved (lib/source-dates.ts). */
  date?: string;
  date_kind?: 'published' | 'saved';
}

interface WritePageResult {
  current_path: string;
  previous_path: string | null;
}

async function callDraftPage(
  pageType: string,
  title: string,
  sourceContents: SourceContent[],
  existingCategories: string[],
  compileModel: string,
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
      compile_model: compileModel,
    }),
    signal: AbortSignal.timeout(600_000), // 10 min — recompile-on-source-delete runs an extract LLM call. DeepSeek can take 200-400s on dense sources. 180s (prior) was Gemini-only sizing.
    // @ts-expect-error — dispatcher is an undici-specific fetch option not in the DOM RequestInit type
    dispatcher: LONG_HTTP_AGENT, // 600s AbortSignal > undici 300s default headersTimeout
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
 * @throws               When the page can't be redrafted. Caller must catch.
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

  // A page held after an earlier failed rewrite is drafted as its own type.
  const pageType = draftPageType(page);

  // ── Build source contents for re-drafting ─────────────────────────────────
  // Provenance gains a row on every compile; send each source once.
  const sourceContents: SourceContent[] = [];
  const seenSources = new Set<string>();
  for (const prov of remainingProvenance) {
    if (prov.source_id === removedSourceId) continue; // belt-and-suspenders
    if (seenSources.has(prov.source_id)) continue;
    seenSources.add(prov.source_id);
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
    .filter((c): c is string => c !== null && c !== 'Uncategorized' && c !== 'General');
  // The model cites [S1]-style labels; they become stored [^source_id]
  // references (lib/citations.ts), as in the compile draft route.
  const labels = assignCitationLabels(sourceContents.map((sc) => sc.source_id));
  // Dates tell a claim that changed over time from a disagreement (plan 3.1).
  const dates = sourceDates(getDb(), sourceContents.map((sc) => sc.source_id));
  const drafted = await callDraftPage(
    pageType,
    page.title,
    sourceContents.map((sc) => withSourceDate({ ...sc, citation_label: labels.get(sc.source_id.toLowerCase()) }, dates)),
    existingCategories,
    getCompileModel(),
  );
  // Same safety nets as the compile draft and crossref steps.
  let newMarkdown = normalizeFrontmatter(labelsToStoredCitations(rewordLabelSubjects(drafted).markdown, labels));
  if (pageType !== 'source-summary') {
    newMarkdown = removeEmptyContradictionSections(newMarkdown).markdown;
  } else {
    newMarkdown = withSourceText(newMarkdown, sourceContents[0].markdown);
  }
  newMarkdown = tidyDraftLinks(newMarkdown, {
    blocked: new Set([...sourceOnlyTitles(getAllPages()), page.title.toLowerCase()]),
    sourceText: sourceContents.map((sc) => sc.markdown).join('\n'),
    keepRelated: relatedLinkTargets(readPageMarkdown(pageId) ?? ''),
    trimRelated: pageType !== 'source-summary',
  }).markdown;

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

    // Drafted from scratch with this version's prompt and cleanup, so the
    // page now follows the current writing rules (lib/draft-rules.ts).
    if (isDraftedPage({ page_id: pageId, page_type: pageType })) setPageDraftRules(db, pageId, CURRENT_DRAFT_RULES);

    // A held page returns now that its text no longer carries the deleted source.
    releaseHeldPage(db, pageId);

    // FTS5 upsert: strip frontmatter before indexing
    const bodyForFts = newMarkdown.replace(/^---[\s\S]*?---\n*/m, '');
    db.prepare('DELETE FROM pages_fts WHERE page_id = ?').run(pageId);
    db.prepare(
      'INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)'
    ).run(pageId, page.title, bodyForFts);

    // Disagreements the committed text records (lib/disagreements.ts).
    recordPageDisagreements(db, { page_id: pageId, title: page.title }, newMarkdown);
  })();

  // ── Phase 3a (awaited): flush pending_content to disk via nlp-service ────
  // On failure pending_content stays set and the boot reconciler
  // (instrumentation.ts) writes the file, as for every commit path.
  let flushed = false;
  try {
    const writeResult = await callWritePage(pageId, newMarkdown);
    clearPendingContent(pageId, writeResult.previous_path);
    flushed = true;
  } catch (err) {
    console.error('[recompile] flush failed; the boot reconciler will retry', pageId, err);
  }

  // ── Phase 3c: sync page_links — clear stale wikilinks, insert current ones ─
  // Must run after Phase 3a so the new markdown is available in newMarkdown.
  // Wrapped in a transaction so a crash between DELETE and INSERT doesn't leave
  // partial/no wikilinks (boot reconciler covers pending_content, not page_links).
  syncPageWikilinks(getDb(), pageId, newMarkdown, getPageTitleMap());

  // ── Phase 3b: vector refresh — fire-and-forget, retried like a compile's ─
  // It reads the flushed file; if the flush failed, the boot reconciler
  // refreshes the vector once it writes the file.
  if (flushed) {
    void upsertVectorWithRetry(pageId, {
      title: page.title,
      page_type: pageType,
      category: page.category ?? '',
      source_count: newSourceCount,
    });
  }

  return { outcome: 'rewritten' };
}
