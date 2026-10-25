/**
 * A synthetic wiki for the backup round-trip test (backup-roundtrip.test.ts):
 * rows in every table and the files a real install keeps under DATA_ROOT
 * (raw source text, page files and their archived versions, schema.md).
 * Deterministic, no LLM, no network. Ids start with "rt-" so the test only
 * ever deletes its own files from the shared test data folder.
 */

import type Database from 'better-sqlite3';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { AGENT_ADD_SOURCES_KEY, DATA_ROOT } from '../../lib/db';
import { ALIAS_SCREEN_THROUGH_KEY, ALIAS_SCREEN_VERSION_KEY } from '../../lib/alias-screen';
import { DISAGREEMENTS_BACKFILL_KEY } from '../../lib/disagreement-backfill';
import { CLAIM_VERDICTS } from '../../lib/claim-check/verdicts';
import { DISAGREEMENT_FINDERS, DISAGREEMENT_KINDS } from '../../lib/disagreements';
import { PAGE_UPGRADE_FLAG } from '../../lib/page-upgrade-state';
import { SOURCE_DATES_BACKFILL_KEY } from '../../lib/source-date-backfill';
import { TRIAGE_RECHECK_FLAG } from '../../lib/triage-rechecks';

export interface WikiScale {
  sources: number;
  pages: number;
  /** compile sessions; also the floor for every other table's row count */
  sessions: number;
  activity: number;
  /** words of raw text per source and of markdown per page */
  rawWords: number;
  pageWords: number;
}

/** Past the 200-row default that once cut backups short, in every table. */
export const EVERYDAY_SCALE: WikiScale = {
  sources: 240, pages: 320, sessions: 210, activity: 600, rawWords: 120, pageWords: 150,
};

/** A large wiki: thousands of sources and pages, a long activity history. */
export const FRIEND_SCALE: WikiScale = {
  sources: 3000, pages: 4000, sessions: 400, activity: 60000, rawWords: 4000, pageWords: 900,
};

/** Settings a backup never restores, seeded so the test can see they stay out. */
export const INSTALL_ONLY_SETTINGS: Record<string, string> = {
  [AGENT_ADD_SOURCES_KEY]: '1',
  [TRIAGE_RECHECK_FLAG]: '1',
  [PAGE_UPGRADE_FLAG]: '1',
  [ALIAS_SCREEN_VERSION_KEY]: 'from-backup',
  [ALIAS_SCREEN_THROUGH_KEY]: '999999',
  [DISAGREEMENTS_BACKFILL_KEY]: 'from-backup',
  [SOURCE_DATES_BACKFILL_KEY]: 'from-backup',
};

export const RAW_DIR = path.join(DATA_ROOT, 'raw');
export const PAGES_DIR = path.join(DATA_ROOT, 'pages');
export const SCHEMA_FILE = path.join(DATA_ROOT, 'schema.md');

export interface SeededWiki {
  /** Every file written, relative to DATA_ROOT. */
  files: string[];
  /** page_id -> pending_content, for pages whose newest text is not on disk yet. */
  pending: Map<string, string>;
}

// Small deterministic PRNG (mulberry32): same wiki on every run.
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const VOCAB = (
  'the of model network graph source page wiki compile entity concept relation language system data ' +
  'learning paper method result value claim history author market policy energy climate protein cell ' +
  'theory proof memory storage index query search vector token layer training dataset benchmark error ' +
  'design pattern service protocol network security privacy law court ruling economy trade growth city ' +
  'river ocean planet orbit star galaxy light quantum field particle engine battery solar wind grid'
).split(' ');

const pad = (n: number) => String(n).padStart(5, '0');
const BASE_MS = Date.UTC(2025, 0, 1, 8, 0, 0);
/** SQLite's "YYYY-MM-DD HH:MM:SS", step seconds apart. */
const ts = (n: number, step = 37) => new Date(BASE_MS + n * step * 1000).toISOString().slice(0, 19).replace('T', ' ');

function writeGz(rel: string, text: string, files: string[]): void {
  fs.writeFileSync(path.join(DATA_ROOT, rel), zlib.gzipSync(Buffer.from(text, 'utf-8')));
  files.push(rel);
}

export function seedWiki(db: Database.Database, scale: WikiScale): SeededWiki {
  const rnd = prng(20261024);
  const pick = <T>(xs: readonly T[]) => xs[Math.floor(rnd() * xs.length)];
  const words = (n: number) => Array.from({ length: n }, () => pick(VOCAB)).join(' ');
  const cap = (w: string) => w[0].toUpperCase() + w.slice(1);
  const files: string[] = [];
  const pending = new Map<string, string>();
  const floor = scale.sessions;
  fs.mkdirSync(RAW_DIR, { recursive: true });
  fs.mkdirSync(PAGES_DIR, { recursive: true });

  const sourceIds = Array.from({ length: scale.sources }, (_, i) => `rt-s${pad(i)}`);
  const pageIds = Array.from({ length: scale.pages }, (_, j) => `rt-p${pad(j)}`);
  const sessionIds = Array.from({ length: scale.sessions }, (_, k) => `rt-session-${pad(k)}`);
  const titles = pageIds.map((_, j) => `${cap(pick(VOCAB))} ${cap(pick(VOCAB))} ${j}`);
  const archivedSources = sourceIds.filter((_, i) => i % 37 === 5);

  db.transaction(() => {
    const src = db.prepare(
      `INSERT INTO sources (source_id, title, source_type, source_url, content_hash, file_path, status,
         date_ingested, metadata, compile_status, compile_attempts, compile_next_eligible_at,
         onboarding_session_id, title_source, title_rescued_at, published_at, published_at_source)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    sourceIds.forEach((id, i) => {
      // Undated sources carry text with no digits, so the import's date
      // backfill finds nothing to add and the row comes back as it left.
      const dated = i % 5 !== 0;
      const type = dated ? pick(['url', 'file', 'text']) : 'text';
      src.run(
        id, `Source ${i} ${words(4)}`, type, type === 'url' ? `https://example.com/a/${id}` : null,
        `sha256-${id}`, `/data/raw/${id}.md.gz`, archivedSources.includes(id) ? 'archived' : 'active',
        ts(i), dated && i % 3 === 0 ? JSON.stringify({ description: words(8) }) : null,
        pick(['active', 'active', 'active', 'failed', 'pending']), i % 3, i % 11 === 0 ? ts(i + 5000) : null,
        sessionIds[i % sessionIds.length], pick(['markitdown', 'filename', 'paste', 'text_first_line', null]),
        i % 9 === 0 ? ts(i + 7000) : null, dated ? `2024-0${1 + (i % 9)}-1${i % 10}` : null,
        dated ? pick(['source_text', 'metadata']) : null,
      );
      writeGz(`raw/${id}.md.gz`, `# Source ${dated ? i : ''}\n\n${words(scale.rawWords)}\n`, files);
    });

    const page = db.prepare(
      `INSERT INTO pages (page_id, title, page_type, category, summary, content_path, previous_content_path,
         last_updated, source_count, created_at, pending_content, draft_rules, restore_page_type, archive_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const fts = db.prepare('INSERT INTO pages_fts (page_id, title, content) VALUES (?, ?, ?)');
    pageIds.forEach((id, j) => {
      const markdown =
        `# ${titles[j]}\n\n${words(scale.pageWords / 2)}\n\n` +
        `See also [[${titles[(j + 1) % scale.pages]}]] and [[${titles[(j + 7) % scale.pages]}]].\n\n` +
        `${words(scale.pageWords / 2)}\n`;
      // Two older versions for one page in ten (file_store keeps two).
      let previous: string | null = null;
      if (j % 10 === 3) {
        for (const stamp of ['20250102-090000-000001', '20250103-090000-000002']) {
          const name = `${id}.${stamp}.md.gz`;
          writeGz(`pages/${name}`, `# ${titles[j]}\n\nOlder text ${stamp}: ${words(40)}\n`, files);
          previous = path.join(PAGES_DIR, name);
        }
      }
      // A few pages committed but not yet on disk: some with an older file, some with none.
      const isPending = j % 97 === 11;
      if (isPending) pending.set(id, markdown);
      if (!isPending) writeGz(`pages/${id}.md.gz`, markdown, files);
      else if (j % 2 === 0) writeGz(`pages/${id}.md.gz`, `# ${titles[j]}\n\nStale text.\n`, files);
      page.run(
        id, titles[j], j % 50 === 7 ? 'archived' : ['entity', 'concept', 'source-summary', 'comparison', 'overview'][j % 5],
        j % 4 === 0 ? null : `Category ${j % 12}`, words(20), `/data/pages/${id}.md.gz`, previous,
        ts(j, 53), 1 + (j % 3), ts(j, 41), isPending ? markdown : null, j % 3 === 0 ? 'v0.4' : null,
        // Half the archived pages are held after a failed rewrite (lib/page-hold.ts).
        j % 100 === 7 ? 'entity' : null, j % 100 === 7 ? `Kompl could not rewrite this page (${words(4)}).` : null,
      );
      fts.run(id, titles[j], markdown);
    });
    const saved = '# Saved Links\n\n- [A saved link](https://example.org/saved/0) — 2025-01-01 · *Could not fetch*\n';
    page.run('saved-links', 'Saved Links', 'overview', null, null, '/data/pages/saved-links.md.gz', null,
      ts(1), 0, ts(1), null, null, null, null);
    fts.run('saved-links', 'Saved Links', saved);
    writeGz('pages/saved-links.md.gz', saved, files);

    const prov = db.prepare(
      `INSERT INTO provenance (source_id, page_id, content_hash, date_compiled, contribution_type) VALUES (?, ?, ?, ?, ?)`,
    );
    pageIds.forEach((id, j) => {
      // Pages whose every source is archived are hidden from the wiki but still the owner's.
      const ids = j % 41 === 9
        ? [archivedSources[j % archivedSources.length]]
        : [...new Set([sourceIds[(j * 7) % scale.sources], sourceIds[(j * 13 + 1) % scale.sources]])];
      ids.forEach((s, n) => prov.run(s, id, `hash-${id}-${n}`, ts(j, 59), pick(['created', 'updated', 'mentioned'])));
    });

    const link = db.prepare(
      `INSERT OR IGNORE INTO page_links (source_page_id, target_page_id, link_type, created_at) VALUES (?, ?, ?, ?)`,
    );
    pageIds.forEach((id, j) => {
      for (const t of [(j + 1) % scale.pages, (j + 7) % scale.pages]) {
        if (t !== j) link.run(id, pageIds[t], 'wikilink', ts(j, 61));
      }
      if (j % 4 === 0) link.run(id, pageIds[(j + 3) % scale.pages], 'entity-ref', ts(j, 67));
    });

    const alias = db.prepare(
      `INSERT INTO aliases (alias, canonical_name, canonical_page_id, created_at, method, score, session_id,
         status, status_reason, status_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let k = 0; k < Math.max(floor, scale.pages / 2); k++) {
      const method = ['exact', 'embedding', 'llm', 'manual', null][k % 5];
      // Rows with no method come back as the screen left them (set aside).
      const status = method === null ? 'suspended' : ['active', 'active', 'suspended', 'retired'][k % 4];
      alias.run(
        `Alt name ${k} ${pick(VOCAB)}`, titles[k % scale.pages], k % 6 === 0 ? null : pageIds[k % scale.pages],
        ts(k, 71), method, method === 'embedding' ? 0.93 : null, sessionIds[k % sessionIds.length], status,
        status === 'active' ? null : 'content_words', status === 'active' ? null : ts(k, 73),
      );
    }

    const ent = db.prepare(
      `INSERT INTO entity_mentions (canonical_name, source_id, entity_type, first_seen_at) VALUES (?, ?, ?, ?)`,
    );
    const rel = db.prepare(
      `INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id, first_seen_at,
         description, quote, quote_verified) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const ext = db.prepare(
      `INSERT INTO extractions (source_id, ner_output, profile, keyphrase_output, tfidf_output, llm_output, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    sourceIds.forEach((id, i) => {
      const names = [0, 1, 2].map((t) => `Entity ${(i * 3 + t) % scale.sources}`);
      names.forEach((n, t) => ent.run(n, id, ['ORG', 'CONCEPT', 'PRODUCT', null][(i + t) % 4], ts(i, 79)));
      [[names[0], names[1]], [names[1], names[2]]].forEach(([from, to], t) => {
        const quote = (i + t) % 4 === 0 ? null : words(20);
        rel.run(from, to, ['uses', 'part_of', 'created_by'][(i + t) % 3], id, ts(i, 83),
          i % 13 === 0 ? null : words(12), quote, quote === null ? null : (i + t) % 2);
      });
      if (i % 10 === 9) return;
      // The LLM relations list stays empty so the import's description
      // backfill has nothing to add to the rows left without one.
      const llm = {
        title: `Source ${i}`, summary: words(40), relationships: [],
        entities: names.map((name) => ({ name, type: 'ORG', description: words(15) })),
        claims: Array.from({ length: Math.max(2, scale.rawWords / 200) }, () => ({ text: words(25) })),
      };
      ext.run(id, JSON.stringify({ entities: names.map((text) => ({ text, label: 'ORG' })) }),
        pick(['default', 'academic']), i % 2 ? JSON.stringify([words(2), words(2)]) : null,
        i % 3 ? JSON.stringify({ terms: [words(1), words(1)] }) : null, JSON.stringify(llm), ts(i, 89));
    });

    const plan = db.prepare(
      `INSERT INTO page_plans (plan_id, session_id, title, page_type, action, source_ids, existing_page_id,
         related_plan_ids, draft_content, draft_status, draft_error, created_at, draft_rules, base_version,
         used_source_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let k = 0; k < Math.max(floor, scale.pages * 1.2); k++) {
      const status = ['planned', 'drafted', 'committed', 'failed', 'approved'][k % 5];
      const used = [sourceIds[k % scale.sources], sourceIds[(k + 1) % scale.sources]];
      plan.run(
        `rt-plan-${pad(k)}`, sessionIds[k % sessionIds.length], titles[k % scale.pages], 'entity',
        k % 3 === 0 ? 'update' : 'create', JSON.stringify(used), k % 3 === 0 ? pageIds[k % scale.pages] : null,
        k % 4 === 0 ? JSON.stringify([`rt-plan-${pad(k + 1)}`]) : null,
        status === 'planned' ? null : words(scale.pageWords), status, status === 'failed' ? 'draft_timeout' : null,
        ts(k, 97), k % 2 ? 'v0.4' : null, k % 5 === 0 ? `${k}:${k * 2}` : null,
        k % 4 === 0 ? JSON.stringify([used[0]]) : null,
      );
    }

    const progress = db.prepare(
      `INSERT INTO compile_progress (session_id, status, current_step, steps, error, started_at, completed_at,
         created_at, source_count, compile_model) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    sessionIds.forEach((id, k) => {
      const status = ['completed', 'failed', 'cancelled', 'completed'][k % 4];
      progress.run(id, status, status === 'completed' ? null : 'draft',
        JSON.stringify([{ key: 'extract', status: 'done', detail: words(5) }]), status === 'failed' ? words(6) : null,
        ts(k, 101), ts(k + 1, 101), ts(k, 101), 1 + (k % 9), ['deepseek-flash', 'gemini-2.5-flash', null][k % 3]);
    });

    const chat = db.prepare(
      `INSERT INTO chat_messages (session_id, role, content, citations, pages_used, chat_model, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const draft = db.prepare(
      `INSERT INTO drafts (draft_id, page_id, draft_content, draft_type, source_id, status, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    const failure = db.prepare(
      `INSERT INTO ingest_failures (failure_id, source_url, title_hint, date_saved, date_attempted, error,
         source_type, resolved_source_id, metadata, session_id, attempts) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const dis = db.prepare(
      `INSERT INTO disagreements (disagreement_id, page_id, found_by, kind, status, owner_verdict, owner_verdict_at,
         topic, reason, anchor, source_a, quote_a, source_b, quote_b, source_ids, match_key, session_id,
         created_at, updated_at, cleared_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const recheck = db.prepare(
      `INSERT INTO triage_rechecks (source_id, page_id, reason, session_id) VALUES (?, ?, 'rate_limited', ?)`,
    );
    const stage = db.prepare(
      `INSERT INTO collect_staging (stage_id, session_id, connector, payload, status) VALUES (?, ?, 'url', ?, 'ingested')`,
    );
    const queue = db.prepare('INSERT INTO vector_backfill_queue (page_id) VALUES (?)');
    const claim = db.prepare(
      `INSERT INTO claim_verdicts (pair_key, source_a, claim_a, source_b, claim_b, subject, verdict, topic, reason,
         newer, found_by, model, session_id, judged_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (let k = 0; k < floor + 10; k++) {
      const judged = CLAIM_VERDICTS[k % CLAIM_VERDICTS.length];
      claim.run(`rt-pair-${pad(k)}`, sourceIds[k % scale.sources], words(15), sourceIds[(k + 5) % scale.sources],
        words(15), words(2), judged, words(3), k % 3 ? words(10) : null, judged === 'outdated' ? (k % 2 ? 'a' : 'b') : null,
        k % 2 ? 'claim_check' : 'wiki_check', k % 4 ? 'deepseek-flash' : null, sessionIds[k % sessionIds.length], ts(k, 131));
      chat.run(`rt-chat-${k % 20}`, k % 2 ? 'assistant' : 'user', words(30), k % 2 ? JSON.stringify([1, 2]) : null,
        k % 2 ? JSON.stringify([pageIds[k % scale.pages]]) : null, k % 2 ? 'gemini-2.5-flash' : null, ts(k, 103));
      draft.run(`rt-draft-${pad(k)}`, k % 3 ? pageIds[k % scale.pages] : null, words(60), k % 2 ? 'update' : 'new',
        k % 4 ? sourceIds[k % scale.sources] : null, ['pending', 'approved', 'rejected'][k % 3], ts(k, 107));
      failure.run(`rt-fail-${pad(k)}`, `https://example.org/saved/${k}`, k % 2 ? `Saved ${words(3)}` : null,
        k % 3 ? '2024-12-01' : null, ts(k, 109), 'firecrawl_error: 403', k % 2 ? 'url' : 'saved-link',
        k % 7 === 0 ? sourceIds[k % scale.sources] : null, k % 2 ? JSON.stringify({ title: words(3) }) : null,
        sessionIds[k % sessionIds.length], 1 + (k % 4));
      const verdict = [null, 'confirmed', 'dismissed'][k % 3];
      const a = sourceIds[k % scale.sources];
      const b = sourceIds[(k + 3) % scale.sources];
      dis.run(`rt-dis-${pad(k)}`, pageIds[(k * 9) % scale.pages], DISAGREEMENT_FINDERS[k % DISAGREEMENT_FINDERS.length],
        DISAGREEMENT_KINDS[k % DISAGREEMENT_KINDS.length], verdict ?? 'possible', verdict, verdict ? ts(k, 113) : null,
        words(4), k % 5 ? words(10) : null, k % 2 ? words(3) : null, a, words(12), b, k % 4 ? words(12) : null,
        JSON.stringify([a, b]), `key-${k}`, sessionIds[k % sessionIds.length], ts(k, 127), ts(k + 2, 127),
        k % 7 === 0 ? ts(k + 4, 127) : null);
      if (k < 30) {
        recheck.run(sourceIds[k], pageIds[k], sessionIds[k]);
        queue.run(pageIds[k]);
      }
      stage.run(`rt-stage-${pad(k)}`, sessionIds[k % sessionIds.length], JSON.stringify({ url: `https://example.org/s/${k}` }));
    }

    const act = db.prepare(
      `INSERT INTO activity_log (timestamp, action_type, source_id, details, session_id, step_key) VALUES (?, ?, ?, ?, ?, ?)`,
    );
    for (let k = 0; k < scale.activity; k++) {
      act.run(ts(k, 3), ['source_added', 'compile_complete', 'page_created', 'lint_complete', 'ingest_failed'][k % 5],
        k % 2 ? sourceIds[k % scale.sources] : null, JSON.stringify({ n: k, note: words(8) }),
        k % 3 ? sessionIds[k % sessionIds.length] : null, k % 3 ? pick(['ingest', 'extract', 'draft', 'commit']) : null);
    }

    const setting = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
    const backedUp: Record<string, string> = {
      auto_approve: '0', daily_cap_usd: '12.5', compile_model: 'deepseek-v4-pro',
      entity_promotion_threshold: '3', last_lint_at: ts(9), wikilinks_resync_version: '1',
    };
    for (let k = 0; k < floor; k++) backedUp[`rt_setting_${pad(k)}`] = words(3);
    for (const [key, value] of Object.entries({ ...backedUp, ...INSTALL_ONLY_SETTINGS })) setting.run(key, value);
  })();

  // The original of an uploaded file stays in raw/uploads once its text is
  // stored as the source's raw file.
  fs.mkdirSync(path.join(RAW_DIR, 'uploads'), { recursive: true });
  for (let n = 0; n < 3; n++) {
    const rel = `raw/uploads/rt-upload-${n}-paper.pdf`;
    fs.writeFileSync(path.join(DATA_ROOT, rel), Buffer.from(`%PDF-1.4 ${words(50)}`));
    files.push(rel);
  }
  fs.writeFileSync(SCHEMA_FILE, '# Wiki schema\n\nHow this wiki is organised.\n');
  files.push('schema.md');
  return { files, pending };
}

const SEEDED_DIRS = ['raw', 'raw/uploads', 'pages'];
const isSeeded = (name: string) => name.startsWith('rt-') || name.startsWith('saved-links.');

/** The fixture's files on disk now, relative to DATA_ROOT. */
export function listSeededFiles(): string[] {
  const out: string[] = [];
  for (const rel of SEEDED_DIRS) {
    const dir = path.join(DATA_ROOT, rel);
    if (!fs.existsSync(dir)) continue;
    for (const name of fs.readdirSync(dir)) if (isSeeded(name)) out.push(`${rel}/${name}`);
  }
  if (fs.existsSync(SCHEMA_FILE)) out.push('schema.md');
  return out.sort();
}

/** Remove every file this fixture (or a restore of it) may have written. */
export function removeSeededFiles(): void {
  for (const rel of listSeededFiles()) fs.rmSync(path.join(DATA_ROOT, rel), { force: true });
}
