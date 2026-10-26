import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';
import { createServer } from '../src/server.js';

export const BASE_URL = 'http://kompl.test';

/** A route answers with a JSON body (status 200) or a full Response. */
export type FakeRoute = unknown | ((url: URL, init?: RequestInit) => Response | Promise<Response>);

export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json' },
  });
}

/**
 * A fake Kompl app keyed by pathname. Records every requested URL so tests
 * can assert which routes a tool used (and which it must never touch).
 */
export function fakeKompl(routes: Record<string, FakeRoute>) {
  const requested: URL[] = [];
  /** JSON bodies of POST requests, in order. */
  const posted: unknown[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    requested.push(url);
    if (typeof init?.body === 'string') posted.push(JSON.parse(init.body));
    const route = routes[url.pathname];
    if (route === undefined) return json({ error: 'not_found' }, 404);
    return typeof route === 'function' ? route(url, init) : json(route);
  }) as typeof fetch;
  return { fetchImpl, requested, posted };
}

/** Connect a real MCP client to a server backed by `fetchImpl`. */
export async function connect(
  fetchImpl: typeof fetch,
  timeoutMs = 1000,
  baseUrl = BASE_URL
): Promise<Client> {
  const server = createServer({ baseUrl, fetchImpl, timeoutMs, slowTimeoutMs: timeoutMs });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  const client = new Client({ name: 'kompl-mcp-test', version: '0.0.0' });
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return client;
}

/** A tool's text exactly as the agent gets it, fence codes included. */
export async function callRaw(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ text: string; isError: boolean }> {
  const result = (await client.callTool({ name, arguments: args })) as CallToolResult;
  const text = result.content
    .map((c) => (c.type === 'text' ? c.text : ''))
    .join('\n');
  return { text, isError: result.isError === true };
}

/**
 * A tool's text with each fence's random code taken out ("<wiki-data>",
 * "</wiki-data>"), so a test can state the whole format. fence.test.ts
 * checks the codes themselves.
 */
export async function call(
  client: Client,
  name: string,
  args: Record<string, unknown> = {}
): Promise<{ text: string; isError: boolean }> {
  const res = await callRaw(client, name, args);
  return { ...res, text: res.text.replace(/<(\/?)wiki-data-[0-9a-f]{8}>/g, '<$1wiki-data>') };
}
