import { describe, expect, it } from 'vitest';
import { call, connect, fakeKompl, json } from './helpers.js';

const ROUTE = '/api/agent/sources';

describe('add_source', () => {
  it('is marked as a tool that changes things, without destroying anything', async () => {
    const { tools } = await (await connect(fakeKompl({}).fetchImpl)).listTools();
    const tool = tools.find((t) => t.name === 'add_source')!;
    expect(tool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, openWorldHint: true });
  });

  it('posts the links with the agent name and reports the session to follow', async () => {
    const kompl = fakeKompl({
      [ROUTE]: { session_id: 's1', queued: 1, added: 1, already_in_wiki: [{ url: 'https://old.test/', source_id: 'src-1' }], blocked: ['https://x.com/a'] },
    });
    const res = await call(await connect(kompl.fetchImpl), 'add_source', {
      urls: ['https://new.test/', 'https://old.test/', 'https://x.com/a'],
    });
    expect(kompl.posted).toEqual([
      { urls: ['https://new.test/', 'https://old.test/', 'https://x.com/a'], client: 'kompl-mcp-test' },
    ]);
    expect(res.isError).toBe(false);
    expect(res.text).toContain('Added 1 source(s) to Kompl; compiling now (session `s1`).');
    expect(res.text).toContain('recent_changes and session_id "s1"');
    expect(res.text).toContain('Already in Kompl: https://old.test/ (source `src-1`)');
    expect(res.text).toContain("Skipped (sites Kompl can't read): https://x.com/a");
  });

  it('sends JSON and warns against resending when Kompl does not answer', async () => {
    let contentType: string | null = null;
    const silent = ((_url: unknown, init?: RequestInit) => {
      contentType = new Headers(init?.headers).get('content-type');
      return new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(init.signal?.reason));
      });
    }) as typeof fetch;
    const res = await call(await connect(silent, 50), 'add_source', { urls: ['https://a.test/'] });
    expect(contentType).toBe('application/json');
    expect(res.isError).toBe(true);
    expect(res.text).toBe(
      'Kompl did not answer in time. The sources may have been saved anyway: check recent_changes or list_sources before sending them again.'
    );
  });

  it('sends a note with its title', async () => {
    const kompl = fakeKompl({ [ROUTE]: { session_id: 's2', queued: 1, added: 1, already_in_wiki: [], blocked: [] } });
    await call(await connect(kompl.fetchImpl), 'add_source', { text: 'We chose SQLite.', title: 'Decision' });
    expect(kompl.posted[0]).toEqual({ text: 'We chose SQLite.', title: 'Decision', client: 'kompl-mcp-test' });
  });

  it('says when there is nothing new', async () => {
    const kompl = fakeKompl({ [ROUTE]: { session_id: null, added: 0, already_in_wiki: [], blocked: [] } });
    expect((await call(await connect(kompl.fetchImpl), 'add_source', { urls: ['https://a.test/'] })).text).toBe(
      'Nothing new to add.'
    );
  });

  it("passes the app's reason through when it refuses", async () => {
    const answers: Array<[number, string]> = [
      [403, 'Adding sources from AI agents is turned off. The user can turn it on in Kompl: Settings → Connect your AI.'],
      [409, 'A compile is already running. Try again when it has finished.'],
      [429, 'AI agents can add 20 sources a day; 2 left now.'],
    ];
    for (const [status, message] of answers) {
      const kompl = fakeKompl({ [ROUTE]: () => json({ error: 'x', message }, status) });
      expect(await call(await connect(kompl.fetchImpl), 'add_source', { urls: ['https://a.test/'] })).toEqual({
        text: message,
        isError: true,
      });
    }
  });

  it('explains a compile that could not start, and older apps', async () => {
    const down = fakeKompl({ [ROUTE]: () => json({ error: 'n8n_unreachable', session_id: 's3' }, 503) });
    expect((await call(await connect(down.fetchImpl), 'add_source', { urls: ['https://a.test/'] })).text).toContain(
      'could not start the compile (n8n_unreachable)'
    );
    const old = fakeKompl({ [ROUTE]: () => new Response('<html>404</html>', { status: 404 }) });
    expect((await call(await connect(old.fetchImpl), 'add_source', { urls: ['https://a.test/'] })).text).toContain(
      'Run `kompl update`'
    );
  });
});
