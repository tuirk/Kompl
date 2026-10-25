/**
 * A wiki repair run (lib/wiki-repair/run.ts, steps.ts) on a seeded wiki with
 * a fake nlp-service (no real LLM call): backup first or nothing, each step's
 * effect, one activity row per step and one for the end, all or none with
 * the backup offered for a restore, the rule-7 guards (flag, fixed bounds,
 * spend guard, daily ceiling) and the lock against compiles.
 */

import fs from 'node:fs';
import path from 'node:path';

import JSZip from 'jszip';
import { afterEach, describe, expect, it, vi } from 'vitest';

const backupControl = vi.hoisted(() => ({ fail: false }));
vi.mock('../lib/wiki-repair/backup', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/wiki-repair/backup')>();
  return {
    ...actual,
    saveRepairBackup: vi.fn(async (now?: Date) => {
      if (backupControl.fail) throw new Error('disk full');
      return actual.saveRepairBackup(now);
    }),
  };
});

import { POST as retryPOST } from '../app/api/compile/retry/route';
import { GET as backupGET } from '../app/api/wiki/repair/backup/route';
import { POST as startPOST } from '../app/api/wiki/repair/start/route';
import { DATA_ROOT, getSetting, getSourceIdsMentioning, insertPageLink, readPageMarkdown } from '../lib/db';
import { REPAIR_CONFIRMED_METHOD, REPAIR_UNDECIDED_REASON } from '../lib/wiki-repair/aliases';
import { MAX_REPAIR_ALIASES, REPAIR_ALIAS_BATCH, REPAIR_BACKUP_DIR, WIKI_REPAIR_FLAG } from '../lib/wiki-repair/limits';
import { computeRepairPlan } from '../lib/wiki-repair/plan';
import { WikiRepairError, requestWikiRepairStop, startWikiRepair } from '../lib/wiki-repair/run';
import {
  __resetWikiRepairStateForTesting,
  isWikiRepairRunning,
  readSavedRun,
  settleAfterRestart,
  wikiRepairBlock,
} from '../lib/wiki-repair/state';
import { EF, ETH, S, mockRepairNlp, pageMarkdown, seedRepairWiki, writePageFile, type FakeNlp } from './helpers/repair-wiki';
import { seedPage, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  backupControl.fail = false;
  __resetWikiRepairStateForTesting();
  handle?.cleanup();
  handle = null;
});

function setup(): FakeNlp {
  handle = setupTestDb();
  seedRepairWiki(handle.db);
  return mockRepairNlp(handle.db);
}

function plannedStart() {
  const plan = computeRepairPlan(handle!.db);
  return { expectedAliases: plan.aliases.length, expectedPages: plan.pages_high, model: 'deepseek-flash' };
}

async function runToEnd(): Promise<void> {
  const { finished } = await startWikiRepair(plannedStart());
  await finished;
}

const alias = (name: string) =>
  handle!.db.prepare('SELECT status, method, status_reason FROM aliases WHERE alias = ?').get(name) as {
    status: string;
    method: string | null;
    status_reason: string | null;
  };
const credited = (pageId: string) =>
  (handle!.db.prepare('SELECT DISTINCT source_id FROM provenance WHERE page_id = ? ORDER BY source_id').all(pageId) as Array<{ source_id: string }>).map((r) => r.source_id);
const repairRows = () =>
  (handle!.db.prepare("SELECT details FROM activity_log WHERE action_type = 'wiki_repair' ORDER BY id").all() as Array<{ details: string }>).map(
    (r) => JSON.parse(r.details) as { phase: string; step: string; reason?: string },
  );

describe('a full run', () => {
  it('backs up, settles the name matches, re-credits sources, rewrites the pages and merges labels', async () => {
    const nlp = setup();
    await runToEnd();
    const run = readSavedRun()!;
    expect(run.status).toBe('finished');
    expect(run.steps_done).toEqual(['backup', 'aliases', 'mentions', 'links', 'pages', 'labels']);

    // 1. The backup is on the data volume and is a kompl backup.
    const file = path.join(DATA_ROOT, REPAIR_BACKUP_DIR, run.backup!.file);
    const zip = await JSZip.loadAsync(fs.readFileSync(file));
    expect(JSON.parse((await zip.file('manifest.json')!.async('string'))).format).toBe('kompl');

    // 2. Same → used again, recorded; different → retired with the reason;
    //    undecided → still set aside; the owner's retired row untouched.
    expect(alias('The Ethereum Foundation')).toMatchObject({ status: 'active', method: REPAIR_CONFIRMED_METHOD });
    expect(alias('ETH')).toMatchObject({ status: 'retired', status_reason: 'different: ETH is the coin, not the foundation' });
    expect(alias('ETC')).toMatchObject({ status: 'suspended', status_reason: REPAIR_UNDECIDED_REASON });
    expect(alias('Ether Foundation')).toMatchObject({ status: 'retired', status_reason: 'owner' });
    expect(nlp.disambiguateBodies).toHaveLength(1);
    expect(nlp.disambiguateBodies[0].pairs.map((p) => p.entity_a.name)).not.toContain('Ether Foundation');

    // 3. Mentions follow the page titles and the active matches only.
    expect(getSourceIdsMentioning('Ethereum').sort()).toEqual([S.eth1, S.eth2, S.eth3, S.ethOwn].sort());
    expect(getSourceIdsMentioning('Ethereum Foundation').sort()).toEqual([S.ef, S.theEf].sort());
    expect(getSourceIdsMentioning('ETH')).toEqual([S.ethTicker]);

    // 4. Both pages rewritten from their new sources, credits changed with them.
    const drafted = Object.fromEntries(nlp.draftBodies.map((b) => [b.title, b.source_contents.map((s) => s.source_id).sort()]));
    expect(drafted['Ethereum Foundation']).toEqual([S.ef, S.theEf].sort());
    expect(drafted.Ethereum).toEqual([S.eth1, S.eth2, S.eth3, S.ethOwn].sort());
    expect(credited(EF)).toEqual([S.ef, S.theEf].sort());
    expect(credited(ETH)).toEqual([S.eth1, S.eth2, S.eth3, S.ethOwn].sort());
    const pages = handle!.db.prepare('SELECT page_id, source_count, pending_content, previous_content_path, draft_rules FROM pages ORDER BY page_id').all() as Array<Record<string, unknown>>;
    for (const p of pages) {
      expect(p.pending_content).toBeNull(); // written to disk (outbox phase 3a)
      expect(p.previous_content_path).toMatch(/\.md\.gz$/); // the old version archived
      expect(p.draft_rules).not.toBeNull();
    }
    expect(pages.find((p) => p.page_id === EF)!.source_count).toBe(2);
    expect(run.pending_pages).toEqual([]);

    // 5. "Crypto" merged into "Cryptocurrency", on the row and in the text.
    expect(nlp.labelBodies[0]).toMatchObject({ existing_labels: [] });
    expect(handle!.db.prepare('SELECT category FROM pages WHERE page_id = ?').get(EF)).toEqual({ category: 'Cryptocurrency' });
    expect(nlp.writes.filter((w) => w === EF)).toHaveLength(2);

    // One activity row per step and one for the end; no per-page rows.
    expect(repairRows().map((r) => r.step ?? r.phase)).toEqual(['backup', 'aliases', 'mentions', 'links', 'pages', 'labels', 'finished']);
    expect(repairRows().at(-1)!.phase).toBe('finished');
    const types = handle!.db.prepare("SELECT DISTINCT action_type FROM activity_log").all() as Array<{ action_type: string }>;
    expect(types.map((t) => t.action_type)).toEqual(['wiki_repair']);
    expect(getSetting(WIKI_REPAIR_FLAG)).toBe('0');
  });

  it('fixes the links written through a name match the AI retires, and keeps the confirmed ones', async () => {
    const nlp = setup();
    const NOTE = 'page-note';
    seedPage(handle!.db, { page_id: NOTE, title: 'Chain notes', page_type: 'concept', category: 'Cryptocurrency' });
    writePageFile(NOTE, pageMarkdown('Chain notes', 'Cryptocurrency', 'Pay in [[Ethereum Foundation|ETH]] to [[Ethereum Foundation|The Ethereum Foundation]].'));
    insertPageLink(NOTE, EF, 'wikilink');
    const plan = computeRepairPlan(handle!.db);
    expect([plan.link_pages_low, plan.link_pages_high]).toEqual([0, 1]);

    await runToEnd();
    const run = readSavedRun()!;
    expect(run.links).toEqual({ pages: 1, links: 1, missed: 0 });
    expect(readPageMarkdown(NOTE)).toContain('Pay in ETH to [[Ethereum Foundation|The Ethereum Foundation]].');
    expect(nlp.writes.filter((w) => w === NOTE)).toHaveLength(1);
    expect(repairRows().find((r) => r.step === 'links')).toMatchObject({ pages: 1, links: 1, missed: 0 });
    expect(repairRows().at(-1)).toMatchObject({ phase: 'finished', links_corrected: 1 });
  });

  it('leaves a page as it was when no source names it any more', async () => {
    const nlp = setup();
    // Every source of this page came through the retired match.
    handle!.db.prepare("INSERT INTO pages (page_id, title, page_type, content_path, source_count) VALUES ('page-only', 'ETH Foundation Grants', 'entity', '/data/pages/page-only.md.gz', 1)").run();
    handle!.db.prepare("INSERT INTO provenance (source_id, page_id, content_hash, contribution_type) VALUES (?, 'page-only', 'h', 'created')").run(S.ethTicker);
    handle!.db.prepare("INSERT INTO entity_mentions (canonical_name, source_id, entity_type) VALUES ('ETH Foundation Grants', ?, 'ORG')").run(S.ethTicker);
    await runToEnd();
    const run = readSavedRun()!;
    expect(run.status).toBe('finished');
    expect(run.issues).toEqual([expect.objectContaining({ page_id: 'page-only', reason: 'no_sources_left' })]);
    expect(credited('page-only')).toEqual([S.ethTicker]);
    expect(nlp.draftBodies.map((b) => b.title)).not.toContain('ETH Foundation Grants');
  });
});

describe('backup first', () => {
  it('refuses to start, and changes nothing, when the backup fails', async () => {
    const nlp = setup();
    backupControl.fail = true;
    await expect(startWikiRepair(plannedStart())).rejects.toSatisfy(
      (e: unknown) => e instanceof WikiRepairError && e.code === 'backup_failed' && e.status === 500,
    );
    expect(getSetting(WIKI_REPAIR_FLAG)).not.toBe('1');
    expect(isWikiRepairRunning()).toBe(false);
    expect(alias('ETH').status).toBe('suspended');
    expect(getSourceIdsMentioning('Ethereum Foundation')).toHaveLength(6);
    expect(nlp.disambiguateBodies).toHaveLength(0);
    expect(repairRows()).toEqual([]);
  });
});

describe('all or none', () => {
  it('stops at the daily limit, does no later step, and offers the backup to restore', async () => {
    const nlp = setup();
    nlp.fail.disambiguate = 503;
    await runToEnd();
    const run = readSavedRun()!;
    expect(run).toMatchObject({ status: 'stopped', stop_reason: 'daily_cost_ceiling', step: 'aliases', steps_done: ['backup'] });
    expect(getSourceIdsMentioning('Ethereum Foundation')).toHaveLength(6); // step 3 never ran
    expect(nlp.draftBodies).toHaveLength(0);
    expect(nlp.labelBodies).toHaveLength(0);
    expect(repairRows().at(-1)).toMatchObject({ phase: 'stopped', reason: 'daily_cost_ceiling' });
    expect(getSetting(WIKI_REPAIR_FLAG)).toBe('0');

    const res = await backupGET();
    expect(res.status).toBe(200);
    expect(res.headers.get('content-disposition')).toContain(run.backup!.file);
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    expect(zip.file('db/aliases.json')).not.toBeNull();
  });

  it('keeps the pages it did not get to, and the next run continues with them', async () => {
    const nlp = setup();
    nlp.fail.draft = 503;
    nlp.draftOkBefore = 1;
    await runToEnd();
    const run = readSavedRun()!;
    expect(run).toMatchObject({ status: 'stopped', stop_reason: 'daily_cost_ceiling', step: 'pages' });
    expect(run.steps_done).toEqual(['backup', 'aliases', 'mentions', 'links']);
    expect(run.pages.rebuilt).toBe(1);
    expect(run.pending_pages.map((p) => p.page_id)).toEqual([EF]);
    expect(nlp.labelBodies).toHaveLength(0);
    expect(credited(EF)).toHaveLength(6); // not rewritten: its sources unchanged too

    // The next plan has the waiting page; no name match is asked about twice.
    const plan = computeRepairPlan(handle!.db);
    expect(plan.aliases).toEqual([]);
    expect(plan.pages_waiting).toBe(1);
    expect(plan.pages.map((p) => p.page_id)).toEqual([EF]);

    nlp.fail.draft = undefined;
    __resetWikiRepairStateForTesting();
    await runToEnd();
    expect(readSavedRun()).toMatchObject({ status: 'finished', pending_pages: [] });
    expect(credited(EF)).toEqual([S.ef, S.theEf].sort());
    expect(nlp.disambiguateBodies).toHaveLength(1);
  });

  it('records a run the app restart interrupted, with its flag off', () => {
    handle = setupTestDb();
    handle.db.prepare("INSERT INTO settings (key, value) VALUES (?, '1')").run(WIKI_REPAIR_FLAG);
    handle.db
      .prepare("INSERT INTO settings (key, value) VALUES ('wiki_repair_state', ?)")
      .run(JSON.stringify({ run_id: 'r', status: 'running', step: 'pages', pages: { current_title: 'X' }, pending_pages: [{ page_id: 'p' }] }));
    settleAfterRestart();
    expect(getSetting(WIKI_REPAIR_FLAG)).toBe('0');
    expect(readSavedRun()).toMatchObject({ status: 'stopped', stop_reason: 'restart', step: 'pages', pending_pages: [{ page_id: 'p' }] });
  });
});

describe('steps that stop or leave work', () => {
  it('stops at the daily limit on the label call, after the pages are done', async () => {
    const nlp = setup();
    nlp.fail.labels = 503;
    await runToEnd();
    expect(readSavedRun()).toMatchObject({
      status: 'stopped',
      stop_reason: 'daily_cost_ceiling',
      step: 'labels',
      steps_done: ['backup', 'aliases', 'mentions', 'links', 'pages'],
    });
    expect(handle!.db.prepare('SELECT category FROM pages WHERE page_id = ?').get(EF)).toEqual({ category: 'Crypto' });
  });

  it('keeps a page the model could not rewrite waiting for the next run, and goes on', async () => {
    const nlp = setup();
    nlp.fail.draft = 502;
    await runToEnd();
    const run = readSavedRun()!;
    expect(run.status).toBe('finished');
    expect(run.pages).toMatchObject({ failed: 2, rebuilt: 0 });
    expect(run.pending_pages.map((p) => p.page_id).sort()).toEqual([EF, ETH].sort());
    expect(credited(EF)).toHaveLength(6);
    expect(repairRows().at(-1)).toMatchObject({ phase: 'finished', pages_waiting: 2 });
  });
});

describe('rule 7 guards', () => {
  it(`asks about at most ${MAX_REPAIR_ALIASES} name matches, ${REPAIR_ALIAS_BATCH} per call`, async () => {
    const nlp = setup();
    const insert = handle!.db.prepare("INSERT INTO aliases (alias, canonical_name, status) VALUES (?, ?, 'suspended')");
    for (let i = 0; i < MAX_REPAIR_ALIASES + 5; i++) insert.run(`Name ${i}`, `Other ${i}`);
    await runToEnd();
    const sent = nlp.disambiguateBodies.flatMap((b) => b.pairs);
    expect(sent).toHaveLength(MAX_REPAIR_ALIASES);
    expect(nlp.disambiguateBodies.every((b) => b.pairs.length <= REPAIR_ALIAS_BATCH)).toBe(true);
    expect((handle!.db.prepare("SELECT COUNT(*) AS n FROM aliases WHERE status = 'suspended' AND status_reason IS NULL").get() as { n: number }).n).toBe(8);
  });

  it('stops before the next call once it spends more than 1.5 × the high estimate', async () => {
    const nlp = setup();
    nlp.spendPerCall = 50;
    await runToEnd();
    expect(readSavedRun()).toMatchObject({ status: 'stopped', stop_reason: 'overspend', steps_done: ['backup', 'aliases'] });
    expect(nlp.draftBodies).toHaveLength(0);
  });

  it('stops on Stop before the next call', async () => {
    const nlp = setup();
    nlp.onDisambiguate = () => requestWikiRepairStop();
    await runToEnd();
    expect(readSavedRun()).toMatchObject({ status: 'stopped', stop_reason: 'user' });
    expect(nlp.draftBodies).toHaveLength(0);
  });

  it('refuses when the plan grew or the model changed since it was shown', async () => {
    setup();
    const shown = plannedStart();
    await expect(startWikiRepair({ ...shown, expectedPages: shown.expectedPages - 1 })).rejects.toSatisfy(
      (e: unknown) => e instanceof WikiRepairError && e.code === 'plan_changed',
    );
    await expect(startWikiRepair({ ...shown, model: 'gemini-2.5-flash' })).rejects.toSatisfy(
      (e: unknown) => e instanceof WikiRepairError && e.code === 'model_changed',
    );
    expect(readSavedRun()).toBeNull(); // no backup taken, no run recorded
  });

  it('refuses while a compile runs, and compiles wait while it runs', async () => {
    const nlp = setup();
    handle!.db.prepare("INSERT INTO compile_progress (session_id, status, steps, source_count) VALUES ('busy', 'queued', '[]', 1)").run();
    await expect(startWikiRepair(plannedStart())).rejects.toSatisfy(
      (e: unknown) => e instanceof WikiRepairError && e.code === 'session_in_progress',
    );
    handle!.db.prepare("UPDATE compile_progress SET status = 'failed', session_id = 's'").run();

    let blocked: unknown = null;
    nlp.onDisambiguate = () => {
      blocked = wikiRepairBlock();
    };
    const { finished } = await startWikiRepair(plannedStart());
    const res = await retryPOST(new Request('http://localhost/api/compile/retry', { method: 'POST', body: JSON.stringify({ session_id: 's' }) }));
    expect(res.status).toBe(409);
    expect(((await res.json()) as { error_code: string }).error_code).toBe('wiki_repair_in_progress');
    await finished;
    expect(blocked).toMatchObject({ error_code: 'wiki_repair_in_progress' });
    expect(wikiRepairBlock()).toBeNull();
  });

  it('POST /api/wiki/repair/start refuses other sites and bad bodies', async () => {
    setup();
    const cross = await startPOST(
      new Request('http://localhost/api/wiki/repair/start', { method: 'POST', headers: { origin: 'https://evil.example', host: 'localhost:3000' }, body: '{}' }),
    );
    expect(cross.status).toBe(403);
    const bad = await startPOST(new Request('http://localhost/api/wiki/repair/start', { method: 'POST', body: JSON.stringify({ model: 'deepseek-flash' }) }));
    expect(bad.status).toBe(400);
  });
});
