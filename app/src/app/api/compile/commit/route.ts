/**
 * POST /api/compile/commit
 *
 * Called BY n8n (internal server-to-server), NOT by the browser.
 * Implements the Pass-5 three-phase commit pattern (CLAUDE.md rule #5).
 *
 * Rule #5 — three phases:
 *   Phase 1 (async pre-work):
 *     - Parse {source_id}
 *     - getSource() — 404 if missing, 409 if already compiled
 *     - readRawMarkdown() — read gzipped markdown from /data/raw/
 *     - POST /pipeline/compile-simple → CompileResult
 *     - POST /pipeline/write-page via nlp-service → write_page() (file write
 *       happens BEFORE the sync transaction; orphaned file on txn failure is
 *       harmless — it will be overwritten on retry with version preserved)
 *   Phase 2 (sync db.transaction()):
 *     - insertPage()
 *     - insertProvenance()
 *     - pages_fts upsert
 *     - markCompileSuccess()
 *     - insertActivity('source_compiled', ...)
 *     NO await inside this callback — better-sqlite3 is sync-only.
 *   Phase 3 (fire-and-forget):
 *     - Entity stub expansion: for each entity in compileResult.entities,
 *       create a stub page (if it doesn't exist) and wire a page_link edge.
 *       Replaced at commit 10 by the full multi-layer NLP pipeline.
 *     - vector upsert lands in commit 6
 *
 * Request:  {source_id: string}
 * Response: {source_id, page_id, status: "compiled"}
 *
 * Errors:
 *   404 — source not found
 *   409 — already compiled (idempotent — n8n treats as success)
 *   429 — nlp-service rate limit (caller should retry later)
 *   503 — daily cost ceiling exceeded
 *   500 — unexpected error
 */

import { NextResponse } from 'next/server';

import {
  getDb,
  getPage,
  getSource,
  insertActivity,
  insertEntityStubPage,
  insertPage,
  insertPageLink,
  insertProvenance,
  markCompileFailed,
  markCompileSuccess,
  readRawMarkdown,
} from '../../../../lib/db';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

// Slugify a title into a URL-safe page_id.
// e.g. "Bitcoin: A Peer-to-Peer System" → "bitcoin-a-peer-to-peer-system"
function slugify(title: string, suffix: string): string {
  const base = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, '')
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .slice(0, 56)
    .replace(/^-+|-+$/g, '');
  return `${base || 'page'}-${suffix}`;
}

interface CompileSimpleResult {
  title: string;
  page_type: string;
  category: string;
  summary: string;
  body: string;
  entities: Array<{ name: string; type: string }>;
}

async function callCompileSimple(
  source_id: string,
  markdown: string
): Promise<CompileSimpleResult> {
  const res = await fetch(`${NLP_SERVICE_URL}/pipeline/compile-simple`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ source_id, markdown }),
    signal: AbortSignal.timeout(120_000), // 120s — Gemini thinking can be slow
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    if (res.status === 429) throw Object.assign(new Error('llm_rate_limited'), { status: 429 });
    if (res.status === 503) throw Object.assign(new Error('daily_cost_ceiling'), { status: 503 });
    throw new Error(`compile_simple_failed: ${res.status} ${detail}`);
  }

  return res.json() as Promise<CompileSimpleResult>;
}

interface WritePageResult {
  current_path: string;
  previous_path: string | null;
}

async function callWritePage(
  page_id: string,
  markdown: string
): Promise<WritePageResult> {
  const res = await fetch(`${NLP_SERVICE_URL}/storage/write-page`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ page_id, markdown }),
    signal: AbortSignal.timeout(30_000),
  });

  if (!res.ok) {
    const detail = await res.text().catch(() => '');
    throw new Error(`write_page_failed: ${res.status} ${detail}`);
  }

  return res.json() as Promise<WritePageResult>;
}

interface EntityStubResult {
  summary: string;
  body: string;
}

async function callEntityStub(name: string, entityType: string): Promise<EntityStubResult> {
  const res = await fetch(`${NLP_SERVICE_URL}/pipeline/compile-entity-stub`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name, entity_type: entityType }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const err = (await res.json().catch(() => ({}))) as { detail?: string };
    const e = Object.assign(
      new Error(err.detail ?? `entity_stub_failed: ${res.status}`),
      { status: res.status }
    );
    throw e;
  }
  return res.json() as Promise<EntityStubResult>;
}

/**
 * Phase 3 entity expansion — fire-and-forget.
 *
 * For each entity Gemini extracted:
 *   1. Slugify entity name → deterministic page_id (same entity from multiple
 *      sources resolves to the same page via ON CONFLICT DO NOTHING).
 *   2. If no page exists: call /pipeline/compile-entity-stub, write the file,
 *      insert stub page into DB + FTS.
 *   3. Wire insertPageLink(sourceSummaryPageId → entityPageId, 'entity-ref').
 *
 * Per-entity isolation: each entity is wrapped in its own try/catch so one
 * failure does not abort the rest. Phase 2 transaction is already committed
 * before this runs. Failures are logged to activity_log for observability.
 *
 * Replaced at commit 10 when the full multi-layer NLP pipeline lands.
 */
async function expandEntities(
  sourceSummaryPageId: string,
  sourceCategory: string,
  entities: Array<{ name: string; type: string }>
): Promise<void> {
  const db = getDb();

  for (const entity of entities) {
    // Entity page_ids are derived purely from the name (no random suffix) so the
    // same entity from multiple sources always resolves to the same page.
    const entityPageId = entity.name
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .replace(/-+/g, '-')
      .slice(0, 64)
      .replace(/^-+|-+$/g, '') || '';

    // Skip empty slugs or self-reference.
    if (!entityPageId || entityPageId === sourceSummaryPageId) continue;

    try {
      const pageType =
        entity.type?.toUpperCase() === 'CONCEPT' ||
        entity.type?.toUpperCase() === 'EVENT' ||
        entity.type?.toUpperCase() === 'OTHER'
          ? 'concept'
          : 'entity';

      // 1. Create stub page if it doesn't already exist.
      const existing = getPage(entityPageId);
      if (!existing) {
        let stubResult: EntityStubResult;
        try {
          stubResult = await callEntityStub(entity.name, entity.type);
        } catch {
          // Rate limit / cost ceiling: fall back to placeholder so the graph
          // edge still gets wired even if the stub content is empty.
          stubResult = { summary: '', body: '' };
        }

        const stubMarkdown = [
          '---',
          `title: "${entity.name.replace(/"/g, '\\"')}"`,
          `page_type: ${pageType}`,
          `category: "${sourceCategory.replace(/"/g, '\\"')}"`,
          `summary: "${stubResult.summary.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
          `entities: []`,
          `last_updated: "${new Date().toISOString()}"`,
          '---',
          '',
          `# ${entity.name}`,
          '',
          stubResult.body,
        ].join('\n');

        const wr = await callWritePage(entityPageId, stubMarkdown);

        insertEntityStubPage({
          page_id: entityPageId,
          title: entity.name,
          page_type: pageType,
          category: sourceCategory,
          summary: stubResult.summary,
          content_path: wr.current_path,
        });
      }

      // 2. Wire the edge — entity page now guaranteed to exist in pages table.
      insertPageLink(sourceSummaryPageId, entityPageId, 'entity-ref');
    } catch {
      // Per-entity catch: log and continue.
      db.prepare(
        `INSERT INTO activity_log (action_type, details)
         VALUES ('entity_expansion_failed', json_object('entity', ?, 'source_page', ?))`
      ).run(entity.name, sourceSummaryPageId);
    }
  }
}

export async function POST(request: Request) {
  // ---- Phase 1: async pre-work ----
  let rawBody: unknown;
  try {
    rawBody = await request.json();
  } catch {
    return NextResponse.json({ error: 'invalid_json' }, { status: 400 });
  }

  if (typeof rawBody !== 'object' || rawBody === null || !('source_id' in rawBody)) {
    return NextResponse.json({ error: 'missing field: source_id' }, { status: 422 });
  }
  const { source_id } = rawBody as { source_id: unknown };
  if (typeof source_id !== 'string' || !source_id) {
    return NextResponse.json({ error: 'source_id must be non-empty string' }, { status: 422 });
  }

  const source = getSource(source_id);
  if (!source) {
    return NextResponse.json({ error: 'source_not_found' }, { status: 404 });
  }

  // Idempotency: if already compiled, return the existing page_id.
  // We check the sources row; the page_id is in provenance.
  const db = getDb();
  const compileRow = db
    .prepare(`SELECT compile_status FROM sources WHERE source_id = ?`)
    .get(source_id) as { compile_status: string } | undefined;

  if (compileRow?.compile_status === 'compiled') {
    const provRow = db
      .prepare(`SELECT page_id FROM provenance WHERE source_id = ? LIMIT 1`)
      .get(source_id) as { page_id: string } | undefined;
    if (!provRow) {
      return NextResponse.json(
        { error: 'already_compiled_missing_provenance' },
        { status: 500 }
      );
    }
    return NextResponse.json(
      { source_id, page_id: provRow.page_id, status: 'compiled', error: 'already_compiled' },
      { status: 409 }
    );
  }

  const markdown = readRawMarkdown(source_id);
  if (!markdown) {
    return NextResponse.json({ error: 'raw_markdown_missing' }, { status: 500 });
  }

  // Call nlp-service to compile the source.
  let compileResult: CompileSimpleResult;
  try {
    compileResult = await callCompileSimple(source_id, markdown);
  } catch (e) {
    const err = e as Error & { status?: number };
    if (err.status === 429) return NextResponse.json({ error: 'llm_rate_limited' }, { status: 429 });
    if (err.status === 503) return NextResponse.json({ error: 'daily_cost_ceiling' }, { status: 503 });
    markCompileFailed(source_id);
    return NextResponse.json({ error: `compile_failed: ${err.message}` }, { status: 500 });
  }

  // Derive page_id from title + 8-char hex suffix from source_id.
  const suffix = source_id.replace(/-/g, '').slice(0, 8);
  const page_id = slugify(compileResult.title, suffix);

  // Build compiled markdown with YAML frontmatter for LLM retrieval enrichment.
  // Frontmatter is read by the Chroma vector store (commit 6) as metadata fields.
  const entityNames = compileResult.entities.map((e) => e.name);
  const frontmatter = [
    '---',
    `title: "${compileResult.title.replace(/"/g, '\\"')}"`,
    `page_type: ${compileResult.page_type}`,
    `category: "${compileResult.category.replace(/"/g, '\\"')}"`,
    `summary: "${compileResult.summary.replace(/"/g, '\\"').replace(/\n/g, ' ')}"`,
    `entities: [${entityNames.map((n) => `"${n.replace(/"/g, '\\"')}"`).join(', ')}]`,
    `sources: ["${source_id}"]`,
    `last_updated: "${new Date().toISOString()}"`,
    '---',
  ].join('\n');

  const pageMarkdown = [
    frontmatter,
    '',
    `# ${compileResult.title}`,
    '',
    `> **Category:** ${compileResult.category}`,
    '',
    compileResult.summary,
    '',
    compileResult.body,
  ].join('\n');

  // Write page file via nlp-service storage endpoint (Phase 1 file write,
  // before the sync transaction — orphan is harmless, overwritten on retry).
  let writeResult: WritePageResult;
  try {
    writeResult = await callWritePage(page_id, pageMarkdown);
  } catch (e) {
    markCompileFailed(source_id);
    const msg = e instanceof Error ? e.message : 'unknown';
    return NextResponse.json({ error: `page_write_failed: ${msg}` }, { status: 500 });
  }

  // ---- Phase 2: synchronous db.transaction callback ----
  // NO await inside. File write is already done above (Phase 1).
  try {
    const txn = db.transaction(() => {
      insertPage({
        page_id,
        title: compileResult.title,
        page_type: compileResult.page_type,
        category: compileResult.category,
        summary: compileResult.summary,
        content_path: writeResult.current_path,
        previous_content_path: writeResult.previous_path,
      });

      insertProvenance({
        source_id,
        page_id,
        content_hash: source.content_hash,
        contribution_type: 'llm-compile',
      });

      // FTS upsert — delete + re-insert to avoid duplicate rows on re-compile.
      db.prepare(`DELETE FROM pages_fts WHERE page_id = ?`).run(page_id);
      db.prepare(
        `INSERT INTO pages_fts (page_id, title, content)
         VALUES (?, ?, ?)`
      ).run(page_id, compileResult.title, compileResult.body);

      markCompileSuccess(source_id, page_id);

      insertActivity({
        action_type: 'source_compiled',
        source_id,
        details: { page_id, title: compileResult.title },
      });
    });
    txn();
  } catch (e) {
    const message = e instanceof Error ? e.message : 'unknown';
    return NextResponse.json({ error: `commit_failed: ${message}` }, { status: 500 });
  }

  // ---- Phase 3: fire-and-forget ----
  // Entity stub pages — does not block the HTTP response.
  // vector upsert lands in commit 6.
  void expandEntities(page_id, compileResult.category, compileResult.entities);

  return NextResponse.json({ source_id, page_id, status: 'compiled' }, { status: 200 });
}
