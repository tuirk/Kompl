/**
 * POST /api/agent/sources — MCP add_source. Pins the safety rules: off by
 * default, at most 5 links per call and 20 items a day, nothing staged while
 * a compile runs, links already in the wiki or on the blocklist set aside,
 * and an addition that does go through starts exactly one compile and shows
 * the agent's name in the activity feed. Also: the switch is exposed by the
 * settings API and never carried in backups.
 */

import JSZip from 'jszip';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../lib/trigger-n8n', () => ({
  triggerSessionCompile: vi.fn(async () => ({ ok: true })),
}));

import { POST } from '../app/api/agent/sources/route';
import { GET as exportGET } from '../app/api/export/route';
import { GET as settingsGET, POST as settingsPOST } from '../app/api/settings/route';
import { isBackedUpSetting } from '../lib/backup-settings';
import { getAgentAddSourcesEnabled, logActivity, setAgentAddSourcesEnabled } from '../lib/db';
import { triggerSessionCompile } from '../lib/trigger-n8n';
import { seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle;

beforeEach(() => {
  handle = setupTestDb();
  vi.mocked(triggerSessionCompile).mockClear();
});

afterEach(() => handle.cleanup());

async function add(body: Record<string, unknown>, headers: Record<string, string> = {}) {
  const res = await POST(
    new Request('http://test/api/agent/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...headers },
      body: JSON.stringify(body),
    })
  );
  return { status: res.status, body: (await res.json()) as Record<string, any> };
}

const staged = () =>
  handle.db.prepare('SELECT connector, payload FROM collect_staging').all() as Array<{ connector: string; payload: string }>;

describe('add_source', () => {
  it('is off by default and stages nothing', async () => {
    const res = await add({ urls: ['https://example.org/a'] });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('agent_sources_disabled');
    expect(staged()).toHaveLength(0);
    expect(triggerSessionCompile).not.toHaveBeenCalled();
  });

  it('stages links with the agent named, starts one compile and logs the addition', async () => {
    setAgentAddSourcesEnabled(true);
    const res = await add({ urls: ['https://example.org/a', 'https://example.org/b'], client: 'Claude Code' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ added: 2, queued: 2 });
    expect(triggerSessionCompile).toHaveBeenCalledTimes(1);
    expect(triggerSessionCompile).toHaveBeenCalledWith(res.body.session_id);
    const rows = staged();
    expect(rows.map((r) => r.connector)).toEqual(['url', 'url']);
    expect(JSON.parse(rows[0].payload).metadata_hint).toEqual({ added_via: 'mcp', client: 'Claude Code' });
    const log = handle.db
      .prepare(`SELECT details FROM activity_log WHERE action_type = 'agent_sources_added'`)
      .get() as { details: string };
    expect(JSON.parse(log.details)).toMatchObject({ count: 2, client: 'Claude Code', session_id: res.body.session_id });
  });

  it('saves a note as pasted text, titled from its first line when no title is given', async () => {
    setAgentAddSourcesEnabled(true);
    const res = await add({ text: '# Decision log\n\nWe chose SQLite.', client: 'Cursor' });
    expect(res.status).toBe(200);
    const [row] = staged();
    expect(row.connector).toBe('paste');
    expect(JSON.parse(row.payload)).toMatchObject({
      title: 'Decision log',
      text: '# Decision log\n\nWe chose SQLite.',
      metadata: { added_via: 'mcp', client: 'Cursor' },
    });
  });

  it('rejects bad requests before staging anything', async () => {
    setAgentAddSourcesEnabled(true);
    const six = Array.from({ length: 6 }, (_, i) => `https://example.org/${i}`);
    for (const body of [{ urls: six }, { urls: ['ftp://example.org/x'] }, { urls: ['https://a.org'], text: 'x' }, {}]) {
      expect((await add(body)).status).toBe(422);
    }
    expect(staged()).toHaveLength(0);
  });

  it('sets aside links already in the wiki and blocked hosts', async () => {
    setAgentAddSourcesEnabled(true);
    const existing = seedSource(handle.db, { source_url: 'https://example.org/old' });
    const res = await add({ urls: ['https://example.org/old', 'https://x.com/someone/status/1'] });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      added: 0,
      session_id: null,
      already_in_wiki: [{ url: 'https://example.org/old', source_id: existing }],
      blocked: ['https://x.com/someone/status/1'],
    });
    expect(staged()).toHaveLength(0);
    expect(triggerSessionCompile).not.toHaveBeenCalled();
  });

  it('waits for a running compile instead of staging', async () => {
    setAgentAddSourcesEnabled(true);
    handle.db
      .prepare(`INSERT INTO compile_progress (session_id, status, steps, started_at) VALUES ('busy', 'running', '{}', datetime('now'))`)
      .run();
    const res = await add({ urls: ['https://example.org/a'] });
    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ error: 'compile_running', active_session_id: 'busy' });
    expect(staged()).toHaveLength(0);
  });

  it('treats the same page written differently as one link, and finds it with or without a trailing slash', async () => {
    setAgentAddSourcesEnabled(true);
    const old = seedSource(handle.db, { source_url: 'https://example.org/old' });
    const res = await add({ urls: ['https://EXAMPLE.org/a', ' https://example.org/a ', 'https://example.org/a', 'https://example.org/old/'] });
    expect(res.body).toMatchObject({ added: 1, already_in_wiki: [{ url: 'https://example.org/old/', source_id: old }] });
    expect(staged()).toHaveLength(1);
  });

  it('finds a saved link whatever its trailing slash or host case, but keeps the path case', async () => {
    setAgentAddSourcesEnabled(true);
    const slash = seedSource(handle.db, { source_url: 'https://example.org/a/' });
    const host = seedSource(handle.db, { source_url: 'https://Example.ORG/b?x=1' });
    seedSource(handle.db, { source_url: 'https://example.org/C' });
    const res = await add({ urls: ['https://example.org/a', 'https://example.org/b/?x=1', 'https://example.org/c'] });
    expect(res.body).toMatchObject({
      added: 1,
      already_in_wiki: [
        { url: 'https://example.org/a', source_id: slash },
        { url: 'https://example.org/b/?x=1', source_id: host },
      ],
    });
    // /C and /c can be different pages: the lower-case one is new.
    expect(staged().map((r) => JSON.parse(r.payload).url)).toEqual(['https://example.org/c']);
  });

  it('treats a link sent with and without its trailing slash as one', async () => {
    setAgentAddSourcesEnabled(true);
    const res = await add({ urls: ['https://example.org/a', 'https://example.org/a/'] });
    expect(res.body.added).toBe(1);
    expect(staged()).toHaveLength(1);
  });

  it('reports links already in the wiki even while a compile runs', async () => {
    setAgentAddSourcesEnabled(true);
    seedSource(handle.db, { source_url: 'https://example.org/old' });
    handle.db
      .prepare(`INSERT INTO compile_progress (session_id, status, steps, started_at) VALUES ('busy', 'running', '{}', datetime('now'))`)
      .run();
    const res = await add({ urls: ['https://example.org/old'] });
    expect(res.status).toBe(200);
    expect(res.body.added).toBe(0);
  });

  it('refuses requests sent by another web page', async () => {
    setAgentAddSourcesEnabled(true);
    const res = await add({ urls: ['https://example.org/a'] }, { origin: 'http://evil.test', host: 'localhost:3000' });
    expect(res.status).toBe(403);
    expect(res.body.error).toBe('cross_site');
    // DNS rebinding: the page's own name, pointed at this machine.
    const rebound = await add({ urls: ['https://example.org/a'] }, { origin: 'http://evil.test:3000', host: 'evil.test:3000' });
    expect(rebound.status).toBe(403);
    expect(staged()).toHaveLength(0);
    // Kompl's own page on localhost still adds.
    const own = await add({ urls: ['https://example.org/a'] }, { origin: 'http://localhost:3000', host: 'localhost:3000' });
    expect(own.status).toBe(200);
  });

  it('keeps and counts items whose compile could not start', async () => {
    setAgentAddSourcesEnabled(true);
    vi.mocked(triggerSessionCompile).mockResolvedValueOnce({ ok: false, reason: 'n8n_unreachable' } as never);
    const res = await add({ urls: ['https://example.org/a'] });
    expect(res.status).toBe(503);
    expect(res.body).toMatchObject({ error: 'n8n_unreachable', added: 1 });
    expect(staged()).toHaveLength(1);
    const logged = handle.db.prepare(`SELECT COUNT(*) AS n FROM activity_log WHERE action_type = 'agent_sources_added'`).get();
    expect(logged).toEqual({ n: 1 });
  });

  it('rejects text longer than 100,000 characters', async () => {
    setAgentAddSourcesEnabled(true);
    expect((await add({ text: 'x'.repeat(100_001) })).status).toBe(422);
  });

  it('holds agents to 20 items a day', async () => {
    setAgentAddSourcesEnabled(true);
    logActivity('agent_sources_added', { source_id: null, details: { count: 18, client: 'x', session_id: 'earlier' } });
    const res = await add({ urls: ['https://example.org/1', 'https://example.org/2', 'https://example.org/3'] });
    expect(res.status).toBe(429);
    expect(res.body).toMatchObject({ error: 'daily_limit', left: 2 });
    expect(staged()).toHaveLength(0);
  });

  it('counts only the last 24 hours', async () => {
    setAgentAddSourcesEnabled(true);
    logActivity('agent_sources_added', { source_id: null, details: { count: 20, client: 'x', session_id: 'old' } });
    handle.db.prepare(`UPDATE activity_log SET timestamp = datetime('now', '-25 hours')`).run();
    expect((await add({ urls: ['https://example.org/a'] })).status).toBe(200);
  });
});

describe('the add_source switch', () => {
  it('is exposed by the settings API, off by default', async () => {
    expect(((await (await settingsGET()).json()) as Record<string, unknown>).agent_add_sources_enabled).toBe(false);
    const post = (body: unknown) =>
      settingsPOST(new Request('http://test/api/settings', { method: 'POST', body: JSON.stringify(body) }));
    expect((await post({ agent_add_sources_enabled: 'yes' })).status).toBe(422);
    expect((await post({ agent_add_sources_enabled: true })).status).toBe(200);
    expect(((await (await settingsGET()).json()) as Record<string, unknown>).agent_add_sources_enabled).toBe(true);
  });

  it('can only be switched on from Kompl itself, not from another site', async () => {
    const switchOn = (headers: Record<string, string>) =>
      settingsPOST(
        new Request('http://test/api/settings', {
          method: 'POST',
          headers,
          body: JSON.stringify({ agent_add_sources_enabled: true }),
        })
      );
    expect((await switchOn({ origin: 'http://evil.test', host: 'localhost:3000' })).status).toBe(403);
    expect((await switchOn({ origin: 'http://evil.test:3000', host: 'evil.test:3000' })).status).toBe(403);
    expect(getAgentAddSourcesEnabled()).toBe(false);
    expect((await switchOn({ origin: 'http://localhost:3000', host: 'localhost:3000' })).status).toBe(200);
    expect(getAgentAddSourcesEnabled()).toBe(true);
  });

  it('is never restored from a backup', () => {
    expect(isBackedUpSetting('agent_add_sources_enabled')).toBe(false);
    expect(isBackedUpSetting('schema_version')).toBe(false);
    expect(isBackedUpSetting('compile_model')).toBe(true);
  });

  it('is left out of backups', async () => {
    setAgentAddSourcesEnabled(true);
    const res = await exportGET(new Request('http://test/api/export?format=kompl'));
    const zip = await JSZip.loadAsync(Buffer.from(await res.arrayBuffer()));
    const keys = (JSON.parse(await zip.file('db/settings.json')!.async('string')) as Array<{ key: string }>).map((s) => s.key);
    expect(keys).not.toContain('agent_add_sources_enabled');
  });
});
