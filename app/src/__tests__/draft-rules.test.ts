/**
 * Writing-rules marker (lib/draft-rules.ts, schema v27).
 *
 * pages.draft_rules says whether a page's text was written from scratch under
 * the v0.4 rules. Settings > Wiki health offers every unmarked page for an
 * update, so a wrong marker either hides an old page or charges for a page
 * that is already current. These tests pin:
 *   - which pages are offered (types, Saved Links, active sources, order);
 *   - every commit path: compile create vs update, approve of a v0.4 draft vs
 *     a draft made before v0.4, original-source pages, recompile;
 *   - the draft step stamping its drafts;
 *   - pages marked with any other rules being offered, so a release with new
 *     rules (lib/writing-rules.ts) needs no change here;
 *   - pages an update could not rebuild being set aside until they change;
 *   - backups carrying both columns, older backups importing as NULL, and
 *     the run flag never travelling in a backup.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import JSZip from 'jszip';
import { describe, it, expect, afterEach, vi } from 'vitest';

import { POST as commitPOST } from '../app/api/compile/commit/route';
import { POST as draftPOST } from '../app/api/compile/draft/route';
import { GET as exportGET } from '../app/api/export/route';
import { POST as importPOST } from '../app/api/import/route';
import { commitSinglePlan } from '../lib/approve-plan';
import { DATA_ROOT, getSetting, setSetting } from '../lib/db';
import {
  CURRENT_DRAFT_RULES,
  PAGE_UPGRADE_SET_ASIDE,
  countCurrentPages,
  countUpgradeCandidates,
  getCandidateSourceIds,
  isDraftedPage,
  isUpgradeCandidate,
  listSetAsidePages,
  listUpgradeCandidates,
  planDraftsFromScratch,
  sanitizeDraftRules,
  setPageAside,
} from '../lib/draft-rules';
import { recompilePage } from '../lib/recompile';
import {
  seedCompileProgress,
  seedPage,
  seedPagePlan,
  seedProvenance,
  seedSource,
  setupTestDb,
  type TestDbHandle,
} from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

const LONG = `${'Proof-of-work secures the network by making each block costly to produce. '.repeat(14)}`;

function draftMd(title: string, body = LONG): string {
  return `---\ntitle: "${title}"\npage_type: concept\ncategory: Crypto\nsummary: A page.\n---\n\n${body}\n`;
}

function rulesOf(pageId: string): string | null | undefined {
  const row = handle!.db.prepare('SELECT draft_rules FROM pages WHERE page_id = ?').get(pageId) as
    | { draft_rules: string | null }
    | undefined;
  return row?.draft_rules;
}

function setRules(pageId: string, rules: string | null): void {
  handle!.db.prepare('UPDATE pages SET draft_rules = ? WHERE page_id = ?').run(rules, pageId);
}

function mockNlp(drafted = draftMd('Drafted')): Array<{ url: string; body: Record<string, unknown> }> {
  const calls: Array<{ url: string; body: Record<string, unknown> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      const body = init?.body ? (JSON.parse(String(init.body)) as Record<string, unknown>) : {};
      calls.push({ url: u, body });
      if (u.endsWith('/storage/write-page')) {
        return Response.json({ current_path: `/data/pages/${String(body.page_id)}.md.gz`, previous_path: null });
      }
      if (u.endsWith('/pipeline/draft-page')) return Response.json({ markdown: drafted });
      if (u.endsWith('/vectors/upsert')) return Response.json({ ok: true });
      return new Response('not found', { status: 404 });
    }),
  );
  return calls;
}

function commitRequest(session_id: string): Request {
  return new Request('http://test/api/compile/commit', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id }),
  });
}

describe('which pages are offered for an update', () => {
  it('lists unmarked pages Kompl drafts that still have an active source, oldest first', () => {
    handle = setupTestDb();
    const db = handle.db;
    const active = seedSource(db, { title: 'Active source' });
    const archived = seedSource(db, { title: 'Archived source' });
    db.prepare("UPDATE sources SET status = 'archived' WHERE source_id = ?").run(archived);

    const pages = {
      newer: seedPage(db, { page_id: 'newer', title: 'Newer', page_type: 'concept' }),
      older: seedPage(db, { page_id: 'older', title: 'Older', page_type: 'entity' }),
      summary: seedPage(db, { page_id: 'summary', title: 'Summary', page_type: 'source-summary' }),
      comparison: seedPage(db, { page_id: 'comparison', title: 'A vs B', page_type: 'comparison' }),
      overview: seedPage(db, { page_id: 'overview', title: 'Overview', page_type: 'overview' }),
      current: seedPage(db, { page_id: 'current', title: 'Current', page_type: 'concept' }),
      note: seedPage(db, { page_id: 'note', title: 'Note', page_type: 'original-source' }),
      savedLinks: seedPage(db, { page_id: 'saved-links', title: 'Saved Links', page_type: 'overview' }),
      archivedOnly: seedPage(db, { page_id: 'archived-only', title: 'Archived only', page_type: 'entity' }),
      noSources: seedPage(db, { page_id: 'no-sources', title: 'No sources', page_type: 'entity' }),
      legacyArchived: seedPage(db, { page_id: 'legacy-archived', title: 'Legacy', page_type: 'archived' }),
    };
    for (const id of Object.values(pages)) {
      if (id !== 'archived-only' && id !== 'no-sources') seedProvenance(db, id, active);
    }
    seedProvenance(db, 'archived-only', archived);
    seedProvenance(db, 'older', active, 'updated'); // duplicate provenance rows count once
    seedProvenance(db, 'older', archived);
    setRules('current', CURRENT_DRAFT_RULES);
    db.prepare("UPDATE pages SET created_at = '2025-01-01 00:00:00' WHERE page_id = 'older'").run();
    db.prepare("UPDATE pages SET created_at = '2026-06-01 00:00:00' WHERE page_id = 'newer'").run();

    const listed = listUpgradeCandidates().map((c) => c.page_id);
    expect(listed[0]).toBe('older');
    expect([...listed].sort()).toEqual(['comparison', 'newer', 'older', 'overview', 'summary']);
    expect(listed.indexOf('older')).toBeLessThan(listed.indexOf('newer'));
    expect(countUpgradeCandidates()).toBe(5);
    expect(isUpgradeCandidate('older')).toBe(true);
    for (const id of ['current', 'note', 'saved-links', 'archived-only', 'no-sources', 'legacy-archived', 'missing']) {
      expect(isUpgradeCandidate(id)).toBe(false);
    }
    // Only active sources, each once.
    expect(getCandidateSourceIds().get('older')).toEqual([active]);
  });

  it('offers pages written under any other rules, so new rules need no change here', () => {
    handle = setupTestDb();
    const db = handle.db;
    const source = seedSource(db, { title: 'Source' });
    const marks: Array<[string, string | null]> = [
      ['earlier-rules', 'v0.3'],
      ['current-rules', CURRENT_DRAFT_RULES],
      ['unmarked', null],
    ];
    for (const [id, rules] of marks) {
      seedPage(db, { page_id: id, title: id, page_type: 'concept' });
      seedProvenance(db, id, source);
      setRules(id, rules);
    }
    expect(listUpgradeCandidates().map((c) => c.page_id).sort()).toEqual(['earlier-rules', 'unmarked']);
    expect(isUpgradeCandidate('earlier-rules')).toBe(true);
    expect(isUpgradeCandidate('current-rules')).toBe(false);
    // The card's "up to date" count: drafted pages under the current rules only.
    expect(countCurrentPages()).toBe(1);
  });

  it('knows which plans drafted from scratch and which pages carry a marker', () => {
    expect(planDraftsFromScratch({ action: 'create', existing_page_id: null })).toBe(true);
    expect(planDraftsFromScratch({ action: 'update', existing_page_id: 'p1' })).toBe(false);
    expect(planDraftsFromScratch({ action: 'update', existing_page_id: null })).toBe(true);
    expect(planDraftsFromScratch({ action: 'provenance-only', existing_page_id: 'p1' })).toBe(false);
    expect(isDraftedPage({ page_id: 'x', page_type: 'entity' })).toBe(true);
    expect(isDraftedPage({ page_id: 'x', page_type: 'original-source' })).toBe(false);
    expect(isDraftedPage({ page_id: 'saved-links', page_type: 'overview' })).toBe(false);
  });

  it('keeps only version labels from untrusted backup rows', () => {
    expect(sanitizeDraftRules('v0.4')).toBe('v0.4');
    expect(sanitizeDraftRules('v1.10.2')).toBe('v1.10.2');
    expect(sanitizeDraftRules(undefined)).toBeNull();
    expect(sanitizeDraftRules(null)).toBeNull();
    expect(sanitizeDraftRules('')).toBeNull();
    expect(sanitizeDraftRules('<script>')).toBeNull();
    expect(sanitizeDraftRules(4)).toBeNull();
  });
});

describe('pages an update could not rebuild', () => {
  function seedOffered(...ids: string[]): Map<string, string> {
    handle = setupTestDb();
    const source = seedSource(handle.db, { title: 'Source' });
    const stamps = new Map<string, string>();
    for (const id of ids) {
      seedPage(handle.db, { page_id: id, title: id.toUpperCase(), page_type: 'entity' });
      seedProvenance(handle.db, id, source);
      const row = handle.db.prepare('SELECT last_updated FROM pages WHERE page_id = ?').get(id) as { last_updated: string };
      stamps.set(id, row.last_updated);
    }
    return stamps;
  }

  it('are set aside until the page changes', () => {
    const stamps = seedOffered('a', 'b');
    setPageAside({ page_id: 'a', last_updated: stamps.get('a')! }, 'draft_too_thin');

    expect(listUpgradeCandidates().map((c) => c.page_id)).toEqual(['b']);
    expect(countUpgradeCandidates()).toBe(1);
    expect(isUpgradeCandidate('a')).toBe(false);
    expect(listSetAsidePages()).toEqual([{ page_id: 'a', title: 'A', reason: 'draft_too_thin' }]);

    handle!.db.prepare("UPDATE pages SET last_updated = '2030-01-01 00:00:00' WHERE page_id = 'a'").run();
    expect(isUpgradeCandidate('a')).toBe(true);
    expect(listSetAsidePages()).toEqual([]);
  });

  it('are retried under new rules, and a malformed row sets nothing aside', () => {
    const stamps = seedOffered('a', 'b');
    setSetting(
      PAGE_UPGRADE_SET_ASIDE,
      JSON.stringify({ a: { rules: 'v0.3', last_updated: stamps.get('a'), reason: 'draft_too_thin' } }),
    );
    expect(isUpgradeCandidate('a')).toBe(true);
    for (const raw of ['not json', '[]', 'null', '{"a": "x"}', '{"a": null}']) {
      setSetting(PAGE_UPGRADE_SET_ASIDE, raw);
      expect(countUpgradeCandidates()).toBe(2);
    }
  });

  it('keep only entries that still apply', () => {
    const stamps = seedOffered('a', 'b');
    setPageAside({ page_id: 'a', last_updated: stamps.get('a')! }, 'draft_too_thin');
    handle!.db.prepare("UPDATE pages SET last_updated = '2030-01-01 00:00:00' WHERE page_id = 'a'").run();
    setPageAside({ page_id: 'b', last_updated: stamps.get('b')! }, 'no_readable_sources');
    expect(Object.keys(JSON.parse(getSetting(PAGE_UPGRADE_SET_ASIDE)!) as object)).toEqual(['b']);
  });
});

describe('compile commit', () => {
  function seedSession(session_id: string): string {
    const source_id = seedSource(handle!.db, { onboarding_session_id: session_id, compile_status: 'in_progress' });
    seedCompileProgress(handle!.db, session_id);
    return source_id;
  }

  it('marks a page created from a v0.4 draft, and not one from an older draft', async () => {
    handle = setupTestDb();
    const source_id = seedSession('s-create');
    seedPagePlan(handle.db, {
      plan_id: 'aaaaaaaa-0000-0000-0000-000000000001',
      session_id: 's-create',
      title: 'Fresh concept',
      page_type: 'concept',
      action: 'create',
      source_ids: [source_id],
      draft_status: 'crossreffed',
      draft_content: draftMd('Fresh concept'),
      draft_rules: CURRENT_DRAFT_RULES,
    });
    seedPagePlan(handle.db, {
      plan_id: 'bbbbbbbb-0000-0000-0000-000000000002',
      session_id: 's-create',
      title: 'Old draft',
      page_type: 'entity',
      action: 'create',
      source_ids: [source_id],
      draft_status: 'crossreffed',
      draft_content: draftMd('Old draft'),
      draft_rules: null,
    });
    mockNlp();

    const res = await commitPOST(commitRequest('s-create'));
    expect(res.status).toBe(200);
    expect(((await res.json()) as { committed: number }).committed).toBe(2);
    expect(rulesOf('fresh-concept-aaaaaaaa')).toBe(CURRENT_DRAFT_RULES);
    expect(rulesOf('old-draft-bbbbbbbb')).toBeNull();
  });

  it('leaves the marker of a page an update-mode draft adds to', async () => {
    handle = setupTestDb();
    const source_id = seedSession('s-update');
    seedPage(handle.db, { page_id: 'old-page', title: 'Old page', page_type: 'entity' });
    seedPage(handle.db, { page_id: 'new-page', title: 'New page', page_type: 'entity' });
    setRules('new-page', CURRENT_DRAFT_RULES);
    for (const existing of ['old-page', 'new-page']) {
      seedPagePlan(handle.db, {
        session_id: 's-update',
        title: existing === 'old-page' ? 'Old page' : 'New page',
        page_type: 'entity',
        action: 'update',
        existing_page_id: existing,
        source_ids: [source_id],
        draft_status: 'crossreffed',
        draft_content: draftMd(existing),
        draft_rules: CURRENT_DRAFT_RULES,
      });
    }
    mockNlp();

    expect((await commitPOST(commitRequest('s-update'))).status).toBe(200);
    expect(rulesOf('old-page')).toBeNull();
    expect(rulesOf('new-page')).toBe(CURRENT_DRAFT_RULES);
  });

  it('never marks an original-source page', async () => {
    handle = setupTestDb();
    const source_id = seedSession('s-original');
    seedPagePlan(handle.db, {
      plan_id: 'cccccccc-0000-0000-0000-000000000003',
      session_id: 's-original',
      title: 'My note',
      page_type: 'original-source',
      action: 'create',
      source_ids: [source_id],
      draft_status: 'crossreffed',
      draft_content: draftMd('My note'),
      draft_rules: CURRENT_DRAFT_RULES,
    });
    mockNlp();

    expect((await commitPOST(commitRequest('s-original'))).status).toBe(200);
    expect(rulesOf('my-note-cccccccc')).toBeNull();
  });
});

describe('approving a draft (auto-approve off)', () => {
  it('marks a page from a v0.4 draft but not one from a draft made before v0.4', async () => {
    handle = setupTestDb();
    const source_id = seedSource(handle.db, {});
    seedPagePlan(handle.db, {
      plan_id: 'dddddddd-0000-0000-0000-000000000004',
      session_id: 's-approve',
      title: 'New rules',
      page_type: 'concept',
      action: 'create',
      source_ids: [source_id],
      draft_status: 'pending_approval',
      draft_content: draftMd('New rules'),
      draft_rules: CURRENT_DRAFT_RULES,
    });
    seedPagePlan(handle.db, {
      plan_id: 'eeeeeeee-0000-0000-0000-000000000005',
      session_id: 's-approve',
      title: 'Waited since v0.3',
      page_type: 'concept',
      action: 'create',
      source_ids: [source_id],
      draft_status: 'pending_approval',
      draft_content: draftMd('Waited since v0.3'),
    });
    mockNlp();

    expect((await commitSinglePlan('dddddddd-0000-0000-0000-000000000004')).ok).toBe(true);
    expect((await commitSinglePlan('eeeeeeee-0000-0000-0000-000000000005')).ok).toBe(true);
    expect(rulesOf('new-rules-dddddddd')).toBe(CURRENT_DRAFT_RULES);
    expect(rulesOf('waited-since-v03-eeeeeeee')).toBeNull();
    expect(countUpgradeCandidates()).toBe(1);
  });

  it('leaves the marker on an approved update', async () => {
    handle = setupTestDb();
    const source_id = seedSource(handle.db, {});
    seedPage(handle.db, { page_id: 'kept-page', title: 'Kept page', page_type: 'concept' });
    seedPagePlan(handle.db, {
      plan_id: 'ffffffff-0000-0000-0000-000000000006',
      session_id: 's-approve-2',
      title: 'Kept page',
      page_type: 'concept',
      action: 'update',
      existing_page_id: 'kept-page',
      source_ids: [source_id],
      draft_status: 'pending_approval',
      draft_content: draftMd('Kept page'),
      draft_rules: CURRENT_DRAFT_RULES,
    });
    mockNlp();

    expect((await commitSinglePlan('ffffffff-0000-0000-0000-000000000006')).ok).toBe(true);
    expect(rulesOf('kept-page')).toBeNull();
  });
});

describe('compile draft step', () => {
  it('stamps LLM drafts with the current rules and leaves source notes unmarked', async () => {
    handle = setupTestDb();
    setSetting('min_source_chars', '0');
    const session_id = 's-draft';
    seedCompileProgress(handle.db, session_id);
    const long = seedSource(handle.db, { onboarding_session_id: session_id, raw_markdown: 'A long article. '.repeat(50) });
    const short = seedSource(handle.db, { onboarding_session_id: session_id, raw_markdown: 'A short note.' });
    const drafted = seedPagePlan(handle.db, {
      session_id,
      title: 'Article',
      page_type: 'source-summary',
      action: 'create',
      source_ids: [long],
    });
    const passthrough = seedPagePlan(handle.db, {
      session_id,
      title: 'Note',
      page_type: 'original-source',
      action: 'create',
      source_ids: [short],
    });
    mockNlp(draftMd('Article'));

    const res = await draftPOST(
      new Request('http://test/api/compile/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id }),
      }),
    );
    expect(res.status).toBe(200);
    const planRules = (planId: string) =>
      (handle!.db.prepare('SELECT draft_status, draft_rules FROM page_plans WHERE plan_id = ?').get(planId) as {
        draft_status: string;
        draft_rules: string | null;
      });
    expect(planRules(drafted)).toEqual({ draft_status: 'drafted', draft_rules: CURRENT_DRAFT_RULES });
    expect(planRules(passthrough)).toEqual({ draft_status: 'drafted', draft_rules: null });
  });
});

describe('recompile after a source delete', () => {
  it('marks the rebuilt page as following the current rules', async () => {
    handle = setupTestDb();
    const a = seedSource(handle.db, { raw_markdown: 'Source A text about proof-of-work.' });
    const b = seedSource(handle.db, { raw_markdown: 'Source B text about proof-of-work.' });
    const pageId = seedPage(handle.db, { page_id: 'pow', title: 'Proof-of-work', page_type: 'concept' });
    seedProvenance(handle.db, pageId, a);
    seedProvenance(handle.db, pageId, b);
    expect(rulesOf(pageId)).toBeNull();
    mockNlp(draftMd('Proof-of-work'));

    expect(await recompilePage(pageId, 'some-deleted-source')).toEqual({ outcome: 'rewritten' });
    expect(rulesOf(pageId)).toBe(CURRENT_DRAFT_RULES);
    expect(isUpgradeCandidate(pageId)).toBe(false);
  });
});

describe('backups', () => {
  async function exportZip(): Promise<JSZip> {
    const res = await exportGET(new Request('http://test/api/export?format=kompl'));
    expect(res.status).toBe(200);
    return JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
  }

  async function importZip(zip: JSZip): Promise<Response> {
    const buf = await zip.generateAsync({ type: 'nodebuffer' });
    const form = new FormData();
    form.set('file', new File([new Uint8Array(buf)], 'backup.kompl.zip'));
    return importPOST(new Request('http://test/api/import', { method: 'POST', body: form }));
  }

  it('carry both markers and never the run flag', async () => {
    handle = setupTestDb();
    mockNlp();
    const source_id = seedSource(handle.db, { raw_markdown: 'Text.' });
    seedPage(handle.db, { page_id: 'marked', title: 'Marked', page_type: 'concept' });
    seedPage(handle.db, { page_id: 'unmarked', title: 'Unmarked', page_type: 'concept' });
    setRules('marked', CURRENT_DRAFT_RULES);
    seedPagePlan(handle.db, { plan_id: 'plan-v04', session_id: 's1', draft_rules: CURRENT_DRAFT_RULES, source_ids: [source_id] });
    seedPagePlan(handle.db, { plan_id: 'plan-old', session_id: 's1', source_ids: [source_id] });
    setSetting('page_upgrade_enabled', '1');
    setSetting('page_upgrade_notice_dismissed', CURRENT_DRAFT_RULES);
    seedProvenance(handle.db, 'unmarked', source_id);
    const unmarkedStamp = (handle.db.prepare("SELECT last_updated FROM pages WHERE page_id = 'unmarked'").get() as {
      last_updated: string;
    }).last_updated;
    setPageAside({ page_id: 'unmarked', last_updated: unmarkedStamp }, 'draft_too_thin');

    const zip = await exportZip();
    const pages = JSON.parse(await zip.file('db/pages.json')!.async('string')) as Array<{ page_id: string; draft_rules: string | null }>;
    expect(Object.fromEntries(pages.map((p) => [p.page_id, p.draft_rules]))).toEqual({ marked: 'v0.4', unmarked: null });
    const plans = JSON.parse(await zip.file('db/page_plans.json')!.async('string')) as Array<{ plan_id: string; draft_rules: string | null }>;
    expect(Object.fromEntries(plans.map((p) => [p.plan_id, p.draft_rules]))).toEqual({ 'plan-v04': 'v0.4', 'plan-old': null });
    const keys = (JSON.parse(await zip.file('db/settings.json')!.async('string')) as Array<{ key: string }>).map((s) => s.key);
    expect(keys).not.toContain('page_upgrade_enabled');
    expect(keys).toContain('page_upgrade_notice_dismissed');
    expect(keys).toContain(PAGE_UPGRADE_SET_ASIDE);

    // Round trip into an empty wiki.
    handle.cleanup();
    handle = setupTestDb();
    expect((await importZip(zip)).status).toBe(200);
    expect(rulesOf('marked')).toBe(CURRENT_DRAFT_RULES);
    expect(rulesOf('unmarked')).toBeNull();
    const planRow = handle.db.prepare("SELECT draft_rules FROM page_plans WHERE plan_id = 'plan-v04'").get() as {
      draft_rules: string | null;
    };
    expect(planRow.draft_rules).toBe(CURRENT_DRAFT_RULES);
    // The restored wiki keeps the same pages set aside.
    expect(listSetAsidePages().map((p) => p.page_id)).toEqual(['unmarked']);
  });

  it('from before v27 import every page as written by an earlier version', async () => {
    handle = setupTestDb();
    mockNlp();
    fs.mkdirSync(path.join(DATA_ROOT, 'pages'), { recursive: true });
    const zip = new JSZip();
    zip.file('manifest.json', JSON.stringify({ format: 'kompl', version: 1, schema_version: 26 }));
    zip.file(
      'db/sources.json',
      JSON.stringify([
        {
          source_id: 'legacy-source',
          title: 'Legacy source',
          source_type: 'text',
          source_url: null,
          content_hash: 'h',
          file_path: '/data/raw/legacy-source.md',
          status: 'active',
          date_ingested: '2026-05-01 10:00:00',
          metadata: null,
        },
      ]),
    );
    zip.file(
      'db/pages.json',
      JSON.stringify([
        {
          page_id: 'legacy-page',
          title: 'Legacy page',
          page_type: 'concept',
          category: null,
          summary: 'Old.',
          content_path: '/data/pages/legacy-page.md.gz',
          previous_content_path: null,
          last_updated: '2026-05-01 10:00:00',
          source_count: 1,
          created_at: '2026-05-01 10:00:00',
        },
        {
          page_id: 'tampered-page',
          title: 'Tampered page',
          page_type: 'concept',
          category: null,
          summary: null,
          content_path: '/data/pages/tampered-page.md.gz',
          previous_content_path: null,
          last_updated: '2026-05-01 10:00:00',
          source_count: 1,
          created_at: '2026-05-01 10:00:00',
          draft_rules: 'DROP TABLE pages',
        },
      ]),
    );
    zip.file(
      'db/provenance.json',
      JSON.stringify(
        ['legacy-page', 'tampered-page'].map((page_id) => ({
          source_id: 'legacy-source',
          page_id,
          content_hash: 'h',
          date_compiled: '2026-05-01 10:00:00',
          contribution_type: 'created',
        })),
      ),
    );
    zip.file('db/settings.json', JSON.stringify([{ key: 'page_upgrade_enabled', value: '1' }]));
    zip.file('pages/legacy-page.md.gz', zlib.gzipSync(Buffer.from(draftMd('Legacy page'))));

    expect((await importZip(zip)).status).toBe(200);
    expect(rulesOf('legacy-page')).toBeNull();
    expect(rulesOf('tampered-page')).toBeNull();
    expect(countUpgradeCandidates()).toBe(2);
    const flag = handle.db.prepare("SELECT value FROM settings WHERE key = 'page_upgrade_enabled'").get();
    expect(flag).toBeUndefined();
  });
});
