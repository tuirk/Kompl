/**
 * Page update ("redraft" internally) and "Restore previous version".
 *
 * A compile only updates the pages its new sources touch, and an update keeps
 * the existing text (the model can't re-check claims against sources it
 * isn't shown). redraftPage rebuilds a page from scratch from ALL its current
 * sources, with the current prompt and cleanup, and marks it as following
 * the current writing rules (lib/draft-rules.ts). It makes one LLM call; the
 * current version is archived by the page write and can be put back with
 * Restore (on the page), which is itself undoable the same way.
 *
 * Users reach redraftPage only through the bulk update and the wiki repair
 * in Settings > Wiki health (lib/page-upgrade.ts, lib/wiki-repair), which
 * run it one page at a time behind an explicit confirmation. Nothing here
 * runs on its own: no boot hook.
 */

import fs from 'node:fs';
import zlib from 'node:zlib';

import {
  getAliases,
  getAllPages,
  getCategoryGroups,
  getCompileModel,
  getDb,
  getMinDraftChars,
  getPage,
  getProvenanceForPage,
  getRunningCompileSession,
  getSource,
  logActivity,
  readPageMarkdown,
  readRawMarkdown,
  safePreviousContentPath,
} from './db';
import { assignCitationLabels, labelsToStoredCitations, rewordLabelSubjects } from './citations';
import { normalizeFrontmatter, relatedLinkTargets, sourceOnlyTitles, tidyDraftLinks } from './draft-cleanup';
import { APP_PAGE_IDS, CURRENT_DRAFT_RULES, DRAFTED_PAGE_TYPES, isDraftedPage } from './draft-rules';
import type { LlmModel } from './llm-models';
import { LONG_HTTP_AGENT } from './long-http-agent';
import { stripFrontmatter } from './markdown';
import { removeEmptyContradictionSections } from './page-sections';
import { commitPageRewrite, pageVersionToken, type CreditChange } from './page-rewrite';
import { draftPageType } from './page-hold';
import { sourceDates, withSourceDate } from './source-dates';
import { injectWikilinks, type WikilinkTarget } from './wikilink-injector';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

/** Page types the LLM writes from sources. Original-source pages hold the user's own text. */
export const REDRAFTABLE_TYPES: ReadonlySet<string> = DRAFTED_PAGE_TYPES;

const MAX_LINK_TITLES = 200;

export class RedraftError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
    message: string,
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

// One action per page at a time. On globalThis so dev-server reloads share it.
const locks: Set<string> = ((globalThis as { __komplPageActionLocks?: Set<string> }).__komplPageActionLocks ??=
  new Set<string>());

async function withPageLock<T>(pageId: string, fn: () => Promise<T>): Promise<T> {
  if (locks.has(pageId)) {
    throw new RedraftError('page_action_in_progress', 409, 'This page is already being updated or restored.');
  }
  locks.add(pageId);
  try {
    return await fn();
  } finally {
    locks.delete(pageId);
  }
}

function assertNoCompileRunning(): void {
  if (getRunningCompileSession()) {
    throw new RedraftError(
      'session_in_progress',
      409,
      'A compile is running. Try again when it has finished, so the two don\'t write the same page.',
    );
  }
}

/**
 * A page whose last save hasn't reached disk yet (pending_content set) must
 * not be replaced: the page write archives the file on disk, so the unsaved
 * version would never be archived. The boot reconciler flushes it.
 */
function assertFlushed(pageId: string): void {
  const row = getDb().prepare('SELECT pending_content IS NOT NULL AS pending FROM pages WHERE page_id = ?').get(pageId) as
    | { pending: number }
    | undefined;
  if (row?.pending) {
    throw new RedraftError(
      'page_flush_pending',
      409,
      "This page's last save hasn't reached disk yet. Restart Kompl (or wait a moment) and try again.",
    );
  }
}

/** A page archived after a failed rewrite (lib/page-hold.ts) counts as the type it returns as. */
export function canRedraft(page: { page_id: string; page_type: string }): boolean {
  return isDraftedPage({ page_id: page.page_id, page_type: draftPageType(page) });
}

interface DraftSource {
  source_id: string;
  title: string;
  markdown: string;
  citation_label?: string;
}

/**
 * The page's current, active sources, each once, in provenance order. With
 * a credit change (the wiki repair), the sources it removes are left out and
 * the ones it adds follow.
 */
function currentSources(pageId: string, credits?: CreditChange): { sources: DraftSource[]; skipped: number } {
  const sources: DraftSource[] = [];
  const seen = new Set<string>(credits?.remove ?? []);
  let skipped = 0;
  const ids = [...getProvenanceForPage(pageId).map((p) => p.source_id), ...(credits?.add ?? [])];
  for (const sourceId of ids) {
    if (seen.has(sourceId)) continue;
    seen.add(sourceId);
    const source = getSource(sourceId);
    if (!source || source.status !== 'active') {
      skipped++;
      continue;
    }
    const markdown = readRawMarkdown(sourceId);
    if (!markdown) {
      skipped++;
      continue;
    }
    sources.push({ source_id: sourceId, title: source.title ?? 'Untitled source', markdown });
  }
  return { sources, skipped };
}

async function readSchema(): Promise<string | null> {
  try {
    const res = await fetch(`${NLP_SERVICE_URL}/storage/read-file`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ path: '/data/schema.md' }),
      signal: AbortSignal.timeout(5_000),
    });
    if (!res.ok) return null;
    return ((await res.json()) as { content?: string }).content ?? null;
  } catch {
    return null;
  }
}

async function draftPage(body: Record<string, unknown>): Promise<string> {
  let res: Response;
  try {
    res = await fetch(`${NLP_SERVICE_URL}/pipeline/draft-page`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(600_000),
      // @ts-expect-error — dispatcher is an undici-specific fetch option not in the DOM RequestInit type
      dispatcher: LONG_HTTP_AGENT, // 600s AbortSignal > undici 300s default headersTimeout
    });
  } catch (err) {
    throw new RedraftError('nlp_unreachable', 503, `Kompl's NLP service did not answer: ${String(err)}`);
  }
  if (res.status === 429) throw new RedraftError('llm_rate_limited', 429, 'The model is rate-limited. Try again in a minute.');
  if (res.status === 503) {
    throw new RedraftError('daily_cost_ceiling', 503, "Today's LLM spending limit is reached. Try again tomorrow or raise the limit in Settings.");
  }
  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new RedraftError('draft_failed', 502, 'The model did not return a page.', { detail: detail.slice(0, 300) });
  }
  return ((await res.json()) as { markdown: string }).markdown;
}

export interface RedraftResult {
  page_id: string;
  status: 'redrafted';
  model: string;
  sources_used: number;
  sources_skipped: number;
  previous_chars: number;
  new_chars: number;
  flushed: boolean;
}

export interface RedraftOptions {
  /**
   * Model to draft with. A bulk update locks the model it confirmed, like a
   * compile session does; without it the current Settings choice is used.
   */
  model?: LlmModel;
  /**
   * The wiki repair (lib/wiki-repair): sources that no longer name the page
   * leave it and sources that now do join it. The page is rebuilt from its
   * sources so changed, and the change is credited in the same commit as
   * the new text (only added sources the draft could read are credited).
   */
  credits?: CreditChange;
  /** No activity row per page: the wiki repair records its run as a whole. */
  quiet?: boolean;
}

/** Rebuild a page from all its current sources. One LLM call. */
export async function redraftPage(pageId: string, options: RedraftOptions = {}): Promise<RedraftResult> {
  const page = getPage(pageId);
  if (!page) throw new RedraftError('page_not_found', 404, 'Page not found.');
  if (!canRedraft(page)) {
    throw new RedraftError('page_not_redraftable', 422, 'Only pages Kompl writes from sources can be updated.');
  }

  // A held page is drafted as its own type and returns as it on commit.
  const pageType = draftPageType(page);

  return withPageLock(pageId, async () => {
    assertNoCompileRunning();
    assertFlushed(pageId);
    const { sources, skipped } = currentSources(pageId, options.credits);
    if (sources.length === 0) {
      throw new RedraftError('no_readable_sources', 422, "None of this page's sources could be read, so it cannot be updated.");
    }

    const expectedToken = pageVersionToken(pageId);
    const model = options.model ?? getCompileModel();
    const previous = readPageMarkdown(pageId) ?? '';

    // Link targets: real pages only (sources are cited, never linked), not
    // the page itself; most-cited first, as in the compile draft step.
    const allPages = getAllPages();
    const sourceTitles = sourceOnlyTitles(allPages);
    const ownTitle = page.title.toLowerCase();
    const linkTitles = [...allPages]
      .sort((a, b) => (b.source_count ?? 0) - (a.source_count ?? 0))
      .map((p) => p.title)
      .filter((t) => !sourceTitles.has(t.toLowerCase()) && t.toLowerCase() !== ownTitle)
      .slice(0, MAX_LINK_TITLES);
    const categories = getCategoryGroups()
      .map((g) => g.category)
      .filter((c): c is string => c !== null && c !== 'Uncategorized' && c !== 'General');

    const labels = assignCitationLabels(sources.map((s) => s.source_id));
    // Dates tell a claim that changed over time from a disagreement (plan 3.1).
    const dates = sourceDates(getDb(), sources.map((s) => s.source_id));
    let drafted: string;
    try {
      drafted = await draftPage({
        page_type: pageType,
        title: page.title,
        source_contents: sources.map((s) =>
          withSourceDate({ ...s, citation_label: labels.get(s.source_id.toLowerCase()) }, dates),
        ),
        related_pages: [],
        existing_content: null,
        schema: await readSchema(),
        existing_page_titles: linkTitles,
        extraction_dossier: '',
        existing_categories: categories,
        earlier_sources: [],
        compile_model: model,
      });
    } catch (err) {
      if (err instanceof RedraftError && !options.quiet) {
        logActivity('page_redraft_failed', {
          source_id: null,
          details: { page_id: pageId, title: page.title, error: err.code },
        });
      }
      throw err;
    }

    // Same safety nets as the compile draft and crossref steps.
    let markdown = normalizeFrontmatter(labelsToStoredCitations(rewordLabelSubjects(drafted).markdown, labels));
    if (pageType !== 'source-summary') markdown = removeEmptyContradictionSections(markdown).markdown;
    const aliasesByTitle = new Map<string, string[]>();
    for (const a of getAliases()) {
      const list = aliasesByTitle.get(a.canonical_name) ?? [];
      list.push(a.alias);
      aliasesByTitle.set(a.canonical_name, list);
    }
    const targets: WikilinkTarget[] = linkTitles.map((title) => ({ title, aliases: aliasesByTitle.get(title) ?? [] }));
    markdown = injectWikilinks(markdown, targets).markdown;
    markdown = tidyDraftLinks(markdown, {
      blocked: new Set([...sourceTitles, ownTitle]),
      sourceText: sources.map((s) => s.markdown).join('\n'),
      surfaces: new Map(targets.map((t) => [t.title.toLowerCase(), t.aliases ?? []])),
      keepRelated: relatedLinkTargets(previous),
      trimRelated: pageType !== 'source-summary',
    }).markdown;

    // Gate 2, as for compiled drafts: a thin draft never replaces the page.
    const bodyChars = stripFrontmatter(markdown).trim().length;
    const threshold = getMinDraftChars();
    if (threshold > 0 && bodyChars < threshold) {
      if (!options.quiet) {
        logActivity('page_redraft_failed', {
          source_id: null,
          details: { page_id: pageId, title: page.title, error: 'draft_too_thin', chars: bodyChars, threshold },
        });
      }
      throw new RedraftError('draft_too_thin', 422, 'The new version was too short, so the page was left unchanged.', {
        chars: bodyChars,
        threshold,
      });
    }

    const result = await commitPageRewrite({
      pageId,
      markdown,
      expectedToken,
      draftRules: CURRENT_DRAFT_RULES,
      releaseHold: true,
      activity: options.quiet
        ? null
        : {
            type: 'page_redrafted',
            details: { page_id: pageId, title: page.title, model, sources: sources.length, draft_rules: CURRENT_DRAFT_RULES },
          },
      credits: options.credits && {
        remove: options.credits.remove,
        add: options.credits.add.filter((id) => sources.some((s) => s.source_id === id)),
      },
    });
    if (!result.ok) {
      throw new RedraftError('page_changed', 409, 'The page changed while it was being updated. Nothing was replaced; try again.');
    }
    return {
      page_id: pageId,
      status: 'redrafted',
      model,
      sources_used: sources.length,
      sources_skipped: skipped,
      previous_chars: previous.length,
      new_chars: markdown.length,
      flushed: result.flushed,
    };
  });
}

/**
 * Put the previous version back. The current one becomes the previous
 * version. The page's draft_rules marker stays as it is: restoring is the
 * user choosing that text, so a bulk update never rewrites the page on its
 * own afterwards, and a restore never makes a page look older than it is.
 */
export async function restorePreviousVersion(pageId: string): Promise<{ page_id: string; status: 'restored'; flushed: boolean }> {
  const page = getPage(pageId);
  if (!page) throw new RedraftError('page_not_found', 404, 'Page not found.');
  if (APP_PAGE_IDS.has(pageId)) throw new RedraftError('page_not_restorable', 422, 'This page is written by Kompl itself.');

  return withPageLock(pageId, async () => {
    assertNoCompileRunning();
    assertFlushed(pageId);
    const archive = safePreviousContentPath(pageId, page.previous_content_path);
    if (!archive || !fs.existsSync(archive)) {
      throw new RedraftError('no_previous_version', 404, 'There is no previous version to restore.');
    }
    const markdown = zlib.gunzipSync(fs.readFileSync(archive)).toString('utf-8');
    const result = await commitPageRewrite({
      pageId,
      markdown,
      expectedToken: pageVersionToken(pageId),
      draftRules: null, // keep the page's marker
      activity: { type: 'page_version_restored', details: { page_id: pageId, title: page.title } },
    });
    if (!result.ok) throw new RedraftError('page_changed', 409, 'The page changed meanwhile. Nothing was replaced; try again.');
    return { page_id: pageId, status: 'restored', flushed: result.flushed };
  });
}
