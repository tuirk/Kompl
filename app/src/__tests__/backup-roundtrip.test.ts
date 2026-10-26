/**
 * A .kompl.zip backup restores the whole wiki. The test seeds every table
 * and every kind of file a real install keeps, takes a backup through
 * GET /api/export?format=kompl, restores it with POST /api/import into an
 * empty database and data folder, then compares each table row for row (a
 * hash of its rows in a fixed order) and each file byte for byte. A column,
 * table or file a restore does not bring back must be listed below with the
 * reason, so a new one cannot go missing from backups unnoticed.
 *
 * The everyday run seeds a few hundred rows of everything, past the
 * 200-row default that once cut backups short. KOMPL_BACKUP_SCALE=full
 * seeds a large wiki (3,000 sources, 4,000 pages) and prints the time and
 * memory the backup and the restore take.
 */

import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { GET as exportGET } from '../app/api/export/route';
import { POST as importPOST } from '../app/api/import/route';
import { isBackedUpSetting } from '../lib/backup-settings';
import { __setDbForTesting, DATA_ROOT, EXPECTED_TABLES } from '../lib/db';
import {
  EVERYDAY_SCALE, FRIEND_SCALE, INSTALL_ONLY_SETTINGS, listSeededFiles, removeSeededFiles, seedWiki,
  type SeededWiki,
} from './helpers/backup-fixture';

const FULL = process.env.KOMPL_BACKUP_SCALE === 'full';
const SCALE = FULL ? FRIEND_SCALE : EVERYDAY_SCALE;
const TIMEOUT = FULL ? 900_000 : 60_000;

type Row = Record<string, unknown>;

interface TableSpec {
  /** Columns a restore does not bring back as they were, and why. */
  notRestored?: Record<string, string>;
  /** The row as compared, with values the restore re-derives blanked. */
  normalize?: (row: Row) => Row;
  /** Restored rows the import writes itself, left out of the comparison. */
  importWritten?: (row: Row) => boolean;
}

const RENUMBERED = 'autoincrement id, renumbered by the import';

/** Every table a backup carries. */
const CARRIED: Record<string, TableSpec> = {
  sources: {},
  // pending_content is written into the backup as the page file instead.
  pages: { notRestored: { pending_content: 'folded into the page file' } },
  pages_fts: {},
  provenance: { notRestored: { id: RENUMBERED } },
  drafts: {},
  activity_log: {
    notRestored: { id: RENUMBERED },
    importWritten: (r) => r.action_type === 'wiki_imported',
  },
  aliases: { notRestored: { id: RENUMBERED } },
  settings: {},
  page_links: {
    notRestored: { id: RENUMBERED },
    // Wikilink rows are re-derived from the restored page text.
    normalize: (r) => (r.link_type === 'wikilink' ? { ...r, created_at: 're-derived' } : r),
  },
  extractions: {},
  page_plans: {
    notRestored: {
      base_version: 'counts provenance ids, which an import renumbers (lib/db.ts getAllPagePlans)',
    },
  },
  compile_progress: {},
  chat_messages: { notRestored: { id: RENUMBERED } },
  entity_mentions: {},
  relationship_mentions: {},
  disagreements: {},
  // The claim check's saved verdicts, so a restore never pays to judge a pair again.
  claim_verdicts: {},
  // The links the owner saved that could not be fetched (the Saved Links page).
  ingest_failures: {},
};

/** Tables a backup leaves out, and why. A restore leaves them empty. */
const LEFT_OUT: Record<string, string> = {
  triage_rechecks: 'retry state, not wiki content (lib/triage-rechecks.ts)',
  vector_backfill_queue: 'a work queue; the import asks for every vector again',
  collect_staging: 'temporary items staged for a compile session (lib/kompl-backup.ts)',
};

/** Files a backup leaves out, and why. */
const LEFT_OUT_FILES: Array<[RegExp, string]> = [
  [/^raw\/uploads\//, "uploaded originals; the wiki reads their text, stored as each source's raw file"],
];

const SCHEMA_SQL = fs.readFileSync(path.join(__dirname, 'helpers', 'schema.sql'), 'utf8');
const DB_DIR = path.join(DATA_ROOT, 'db');
const LLM_CONFIG = path.join(DATA_ROOT, 'llm-config.json');
const opened: Database.Database[] = [];

function openDb(name: string): Database.Database {
  const file = path.join(DB_DIR, name);
  fs.rmSync(file, { force: true });
  const db = new Database(file);
  opened.push(db);
  // As lib/db.ts opens the real database.
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('foreign_keys = ON');
  db.pragma('cache_size = -64000');
  db.exec(SCHEMA_SQL);
  __setDbForTesting(db);
  return db;
}

interface TableSnapshot {
  hash: string;
  count: number;
  /** The rows as compared, for the message on a mismatch; the large-wiki run keeps only the hash. */
  rows: string[];
}

function snapshotTable(db: Database.Database, table: string, side: 'original' | 'restored', keys?: Set<string>): TableSnapshot {
  const spec = CARRIED[table] ?? {};
  let rows = db.prepare(`SELECT * FROM ${table}`).all() as Row[];
  if (side === 'restored' && spec.importWritten) rows = rows.filter((r) => !spec.importWritten!(r));
  if (table === 'settings') rows = rows.filter((r) => (keys ? keys.has(r.key as string) : isBackedUpSetting(r.key as string)));
  const serialized = rows
    .map((r) => {
      const row = { ...r };
      for (const col of Object.keys(spec.notRestored ?? {})) delete row[col];
      return JSON.stringify(spec.normalize ? spec.normalize(row) : row);
    })
    .sort();
  const hash = createHash('sha256');
  for (const row of serialized) hash.update(row).update('\n');
  // The large-wiki run holds no rows, so the memory it reports is the backup's.
  return { hash: hash.digest('hex'), count: serialized.length, rows: FULL ? [] : serialized };
}

function describeDiff(table: string, a: TableSnapshot, b: TableSnapshot): string {
  const inB = new Set(b.rows);
  const inA = new Set(a.rows);
  const missing = a.rows.filter((r) => !inB.has(r));
  const extra = b.rows.filter((r) => !inA.has(r));
  const show = (rows: string[]) => rows.slice(0, 2).map((r) => (r.length > 200 ? `${r.slice(0, 200)}…` : r)).join(' | ');
  return `${table}: ${a.count} rows backed up, ${b.count} restored; ` +
    `${missing.length} missing or changed, e.g. ${show(missing)}; ` +
    `${extra.length} unexpected, e.g. ${show(extra)}`;
}

const sha = (buf: Buffer) => createHash('sha256').update(buf).digest('hex');
const leftOutFile = (rel: string) => LEFT_OUT_FILES.some(([re]) => re.test(rel));

/** The files a restore must bring back: bytes, or the newest text for a page not yet on disk. */
function expectedFiles(seeded: SeededWiki): Map<string, string> {
  const out = new Map<string, string>();
  for (const rel of seeded.files) {
    if (!leftOutFile(rel)) out.set(rel, `bytes:${sha(fs.readFileSync(path.join(DATA_ROOT, rel)))}`);
  }
  for (const [pageId, markdown] of seeded.pending) {
    out.set(`pages/${pageId}.md.gz`, `text:${sha(Buffer.from(markdown, 'utf-8'))}`);
  }
  return out;
}

function restoredFile(rel: string, kind: string): string {
  const buf = fs.readFileSync(path.join(DATA_ROOT, rel));
  return kind === 'text' ? `text:${sha(zlib.gunzipSync(buf))}` : `bytes:${sha(buf)}`;
}

interface Measured<T> {
  result: T;
  ms: number;
  startRssMb: number;
  startHeapMb: number;
  peakRssMb: number;
  peakHeapMb: number;
  /** The process's peak RSS so far, before and after the step. */
  maxRssBeforeMb: number;
  maxRssAfterMb: number;
}

/** Wall time and memory of one step: sampled peaks plus the process's peak RSS. */
async function measured<T>(fn: () => Promise<T>): Promise<Measured<T>> {
  const mb = (n: number) => Math.round(n / 1048576);
  const begin = process.memoryUsage();
  let peakRss = begin.rss;
  let peakHeap = begin.heapUsed;
  const sample = setInterval(() => {
    const m = process.memoryUsage();
    peakRss = Math.max(peakRss, m.rss);
    peakHeap = Math.max(peakHeap, m.heapUsed);
  }, 10);
  const maxRssBefore = process.resourceUsage().maxRSS;
  const start = performance.now();
  try {
    const result = await fn();
    const end = process.memoryUsage();
    return {
      result,
      ms: Math.round(performance.now() - start),
      startRssMb: mb(begin.rss),
      startHeapMb: mb(begin.heapUsed),
      peakRssMb: mb(Math.max(peakRss, end.rss)),
      peakHeapMb: mb(Math.max(peakHeap, end.heapUsed)),
      maxRssBeforeMb: Math.round(maxRssBefore / 1024),
      maxRssAfterMb: Math.round(process.resourceUsage().maxRSS / 1024),
    };
  } finally {
    clearInterval(sample);
  }
}

const original = new Map<string, TableSnapshot>();
const restored = new Map<string, TableSnapshot>();
const restoredRows = new Map<string, number>();
let originalSettings = new Map<string, string>();
let restoredSettings = new Map<string, string>();
let files = new Map<string, string>();
let importedEvents = 0;
let manifest: { missing_files?: string[] } = {};
let leftOut = -1;

describe(`a .kompl backup restores the whole wiki (${FULL ? 'large wiki' : 'everyday'} scale)`, () => {
  beforeAll(async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response('{}', { status: 503 })));
    removeSeededFiles();
    const source = openDb('rt-original.db');
    const seeded = seedWiki(source, SCALE);
    for (const table of Object.keys(CARRIED)) original.set(table, snapshotTable(source, table, 'original'));
    originalSettings = new Map((source.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
    files = expectedFiles(seeded);

    const exported = await measured(async () => {
      const res = await exportGET(new Request('http://test/api/export?format=kompl'));
      expect(res.status).toBe(200);
      return Buffer.from(await res.arrayBuffer());
    });
    const zip = exported.result;
    manifest = JSON.parse(await (await JSZip.loadAsync(zip)).file('manifest.json')!.async('string')) as typeof manifest;

    // An empty install: a new database and no wiki files.
    source.close();
    removeSeededFiles();
    const restoredDb = openDb('rt-restored.db');
    const imported = await measured(async () => {
      const form = new FormData();
      form.set('file', new File([new Uint8Array(zip)], 'kompl-export.kompl.zip'));
      const res = await importPOST(new Request('http://test/api/import', { method: 'POST', body: form }));
      expect(res.status, await res.clone().text()).toBe(200);
      return res;
    });

    leftOut = ((await imported.result.json()) as { skipped: { total: number } }).skipped.total;
    const backedUpKeys = new Set([...originalSettings.keys()].filter(isBackedUpSetting));
    for (const table of Object.keys(CARRIED)) restored.set(table, snapshotTable(restoredDb, table, 'restored', table === 'settings' ? backedUpKeys : undefined));
    for (const table of Object.keys(LEFT_OUT)) {
      restoredRows.set(table, (restoredDb.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get() as { n: number }).n);
    }
    restoredSettings = new Map((restoredDb.prepare('SELECT key, value FROM settings').all() as Array<{ key: string; value: string }>).map((r) => [r.key, r.value]));
    importedEvents = (restoredDb.prepare(`SELECT COUNT(*) AS n FROM activity_log WHERE action_type = 'wiki_imported'`).get() as { n: number }).n;

    if (FULL) {
      const report = (label: string, m: Measured<unknown>) =>
        `${label}: ${(m.ms / 1000).toFixed(1)} s; RSS ${m.startRssMb} -> peak ${m.peakRssMb} MB; ` +
        `heap ${m.startHeapMb} -> peak ${m.peakHeapMb} MB; process peak RSS ${m.maxRssBeforeMb} -> ${m.maxRssAfterMb} MB`;
      // Sizes before the zip's own compression. Each table is one JSON
      // string on both sides, and V8 caps a string at about 512 MB.
      const entries = Object.values((await JSZip.loadAsync(zip)).files)
        .filter((f) => !f.dir)
        .map((f) => ({ name: f.name, size: (f as unknown as { _data: { uncompressedSize: number } })._data.uncompressedSize }));
      const mbOf = (n: number) => `${(n / 1048576).toFixed(1)} MB`;
      const total = (prefix: string) => mbOf(entries.filter((f) => f.name.startsWith(prefix)).reduce((n, f) => n + f.size, 0));
      const largest = entries
        .filter((f) => f.name.startsWith('db/'))
        .sort((x, y) => y.size - x.size)
        .slice(0, 3)
        .map((f) => `${f.name} ${mbOf(f.size)}`);
      // Straight to stderr: vitest holds back console output of passing tests.
      process.stderr.write([
        `[backup-roundtrip] ${SCALE.sources} sources, ${SCALE.pages} pages, ${SCALE.activity} activity rows`,
        `zip ${mbOf(zip.length)}: db/ ${total('db/')}, raw/ ${total('raw/')}, pages/ ${total('pages/')}`,
        `largest tables: ${largest.join(', ')}`,
        report('export', exported),
        report('import', imported),
      ].join('\n') + '\n');
    }
  }, TIMEOUT);

  afterAll(() => {
    vi.unstubAllGlobals();
    __setDbForTesting(null);
    for (const db of opened) if (db.open) db.close();
    removeSeededFiles();
    fs.rmSync(LLM_CONFIG, { force: true });
    for (const name of ['rt-original.db', 'rt-restored.db']) {
      for (const suffix of ['', '-wal', '-shm']) fs.rmSync(path.join(DB_DIR, name + suffix), { force: true });
    }
  });

  it('every table is either carried or left out for a stated reason', () => {
    expect([...Object.keys(CARRIED), ...Object.keys(LEFT_OUT)].sort()).toEqual([...EXPECTED_TABLES].sort());
  });

  it.each(Object.keys(CARRIED))('%s comes back row for row', (table) => {
    const a = original.get(table)!;
    const b = restored.get(table)!;
    // More than 200 rows of everything: past the cap that once cut backups short.
    expect(a.count).toBeGreaterThan(200);
    expect(b.hash, describeDiff(table, a, b)).toBe(a.hash);
  });

  it.each(Object.keys(LEFT_OUT))('%s is left out', (table) => {
    expect(restoredRows.get(table)).toBe(0);
  });

  it('every file comes back byte for byte', () => {
    const present = listSeededFiles().filter((rel) => !leftOutFile(rel));
    expect(present).toEqual([...files.keys()].sort());
    const changed = [...files].filter(([rel, want]) => restoredFile(rel, want.split(':')[0]) !== want).map(([rel]) => rel);
    expect(changed).toEqual([]);
  }, TIMEOUT);

  it("restores the owner's settings but not the install's own", () => {
    for (const [key, value] of Object.entries(INSTALL_ONLY_SETTINGS)) {
      expect(restoredSettings.get(key), key).not.toBe(value);
    }
    expect(originalSettings.get('compile_model')).toBe('deepseek-v4-pro');
    expect(restoredSettings.get('compile_model')).toBe('deepseek-v4-pro');
    // The daily cap Settings shows is the one nlp-service enforces.
    const enforced = JSON.parse(fs.readFileSync(LLM_CONFIG, 'utf-8')) as { daily_cap_usd: number };
    expect(enforced.daily_cap_usd).toBe(Number(originalSettings.get('daily_cap_usd')));
  });

  it('names no file as missing from the backup', () => {
    expect(manifest.missing_files).toEqual([]);
  });

  it('the restore leaves no row out', () => {
    expect(leftOut).toBe(0);
  });

  it('logs the restore once', () => {
    expect(importedEvents).toBe(1);
  });
});
