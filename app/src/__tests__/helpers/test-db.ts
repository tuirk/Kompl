import Database from 'better-sqlite3';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import { __setDbForTesting, DATA_ROOT } from '../../lib/db';

const SCHEMA_SQL = readFileSync(join(__dirname, 'schema.sql'), 'utf8');

export interface TestDbHandle {
  db: Database.Database;
  cleanup: () => void;
}

export function setupTestDb(): TestDbHandle {
  const db = new Database(':memory:');
  db.pragma('foreign_keys = ON');
  db.exec(SCHEMA_SQL);
  // Pin entity_promotion_threshold to 2 so most test fixtures (which seed
  // 2-3 sources) reliably promote their entities without also pinning the
  // threshold in every file. Tests that specifically exercise the threshold
  // override via setSetting.
  db.prepare(
    `INSERT OR REPLACE INTO settings (key, value) VALUES ('entity_promotion_threshold', '2')`
  ).run();
  __setDbForTesting(db);
  return {
    db,
    cleanup: () => {
      __setDbForTesting(null);
      db.close();
    },
  };
}

// ── Seed helpers ─────────────────────────────────────────────────────────────

export interface SeedSourceArgs {
  source_id?: string;
  title?: string;
  source_type?: string;
  source_url?: string | null;
  file_path?: string;
  onboarding_session_id?: string | null;
  compile_status?: string;
  raw_markdown?: string;
}

export function seedSource(db: Database.Database, args: SeedSourceArgs = {}): string {
  const source_id = args.source_id ?? `src-${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO sources
       (source_id, title, source_type, source_url, content_hash, file_path,
        status, metadata, compile_status, onboarding_session_id)
     VALUES (?, ?, ?, ?, ?, ?, 'active', NULL, ?, ?)`
  ).run(
    source_id,
    args.title ?? `Source ${source_id}`,
    args.source_type ?? 'text',
    args.source_url ?? null,
    'sha256-test',
    args.file_path ?? `/data/raw/${source_id}.md`,
    args.compile_status ?? 'pending',
    args.onboarding_session_id ?? null
  );
  if (args.raw_markdown !== undefined) {
    seedRawMarkdown(source_id, args.raw_markdown);
  }
  return source_id;
}

// readRawMarkdown reads from <DATA_ROOT>/raw/<source_id>.md.gz.
// setup-env.ts ensures the directory exists. Each test's source_id is unique
// so there's no cleanup conflict.
export function seedRawMarkdown(sourceId: string, markdown: string): void {
  const rawDir = join(DATA_ROOT, 'raw');
  if (!existsSync(rawDir)) mkdirSync(rawDir, { recursive: true });
  writeFileSync(join(rawDir, `${sourceId}.md.gz`), gzipSync(Buffer.from(markdown, 'utf-8')));
}

export interface SeedExtractionArgs {
  source_id: string;
  llm_output?: object;
  ner_output?: object;
  profile?: string;
}

export function seedExtraction(db: Database.Database, args: SeedExtractionArgs): void {
  db.prepare(
    `INSERT INTO extractions
       (source_id, ner_output, profile, keyphrase_output, tfidf_output, llm_output)
     VALUES (?, ?, ?, NULL, NULL, ?)`
  ).run(
    args.source_id,
    JSON.stringify(args.ner_output ?? { entities: [] }),
    args.profile ?? 'default',
    JSON.stringify(args.llm_output ?? { concepts: [], relationships: [] })
  );

  // Mirror extract route's v17 write-through to entity_mentions +
  // relationship_mentions. Without this, plan-route threshold queries see
  // zero mentions and emit no entity/comparison pages even when tests seed
  // the underlying extraction rows. Alias pinning is a no-op in tests
  // (no aliases seeded), so canonical = raw name.
  const llm = (args.llm_output ?? { entities: [], concepts: [], relationships: [] }) as {
    entities?: Array<{ name?: string; type?: string }>;
    concepts?: Array<{ name?: string }>;
    relationships?: Array<{ from_entity?: string; to?: string; type?: string }>;
  };
  const entStmt = db.prepare(
    `INSERT OR IGNORE INTO entity_mentions (canonical_name, source_id, entity_type)
     VALUES (?, ?, ?)`
  );
  const seen = new Set<string>();
  for (const ent of llm.entities ?? []) {
    const name = (ent.name ?? '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entStmt.run(name, args.source_id, (ent.type ?? '').trim() || null);
  }
  for (const con of llm.concepts ?? []) {
    const name = (con.name ?? '').trim();
    if (!name) continue;
    const key = name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    entStmt.run(name, args.source_id, 'CONCEPT');
  }

  const DIRECTION_AGNOSTIC = new Set(['competes_with', 'contradicts']);
  const relStmt = db.prepare(
    `INSERT OR IGNORE INTO relationship_mentions
       (from_canonical, to_canonical, relationship_type, source_id)
     VALUES (?, ?, ?, ?)`
  );
  for (const rel of llm.relationships ?? []) {
    const fromRaw = (rel.from_entity ?? '').trim();
    const toRaw = (rel.to ?? '').trim();
    const type = (rel.type ?? '').trim();
    if (!fromRaw || !toRaw || !type) continue;
    let from = fromRaw;
    let to = toRaw;
    if (DIRECTION_AGNOSTIC.has(type) && from.toLowerCase() > to.toLowerCase()) {
      [from, to] = [to, from];
    }
    relStmt.run(from, to, type, args.source_id);
  }
}

export interface SeedPageArgs {
  page_id?: string;
  title?: string;
  page_type?: string;
  category?: string | null;
  summary?: string | null;
  content_path?: string;
}

export function seedPage(db: Database.Database, args: SeedPageArgs = {}): string {
  const page_id = args.page_id ?? `page-${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO pages
       (page_id, title, page_type, category, summary, content_path,
        previous_content_path, source_count)
     VALUES (?, ?, ?, ?, ?, ?, NULL, 1)`
  ).run(
    page_id,
    args.title ?? `Page ${page_id}`,
    args.page_type ?? 'entity',
    args.category ?? null,
    args.summary ?? null,
    args.content_path ?? `/data/pages/${page_id}.md.gz`
  );
  return page_id;
}

export interface SeedPagePlanArgs {
  plan_id?: string;
  session_id: string;
  title?: string;
  page_type?: string;
  action?: string;
  source_ids?: string[];
  existing_page_id?: string | null;
  related_plan_ids?: string[];
  draft_content?: string | null;
  draft_status?: string;
}

export function seedPagePlan(db: Database.Database, args: SeedPagePlanArgs): string {
  const plan_id = args.plan_id ?? `plan-${randomUUID().slice(0, 8)}`;
  db.prepare(
    `INSERT INTO page_plans
       (plan_id, session_id, title, page_type, action,
        source_ids, existing_page_id, related_plan_ids,
        draft_content, draft_status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    plan_id,
    args.session_id,
    args.title ?? `Plan ${plan_id}`,
    args.page_type ?? 'entity',
    args.action ?? 'create',
    JSON.stringify(args.source_ids ?? []),
    args.existing_page_id ?? null,
    args.related_plan_ids ? JSON.stringify(args.related_plan_ids) : null,
    args.draft_content ?? null,
    args.draft_status ?? 'planned'
  );
  return plan_id;
}

export function seedCompileProgress(db: Database.Database, sessionId: string, sourceCount = 1): void {
  db.prepare(
    `INSERT INTO compile_progress (session_id, status, steps, source_count)
     VALUES (?, 'in_progress', '[]', ?)`
  ).run(sessionId, sourceCount);
}
