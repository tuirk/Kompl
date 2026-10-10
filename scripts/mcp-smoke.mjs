#!/usr/bin/env node
/**
 * MCP smoke check: launch the built MCP server over stdio the way an AI
 * agent does and call every tool against a running Kompl app. Used by
 * integration-test.sh stage 28; also handy by hand after `kompl start`:
 *
 *   node scripts/mcp-smoke.mjs            (KOMPL_URL defaults to localhost:3000)
 *
 * Needs mcp-server built (npm ci && npm run build in mcp-server/). Changes
 * nothing: add_source gets an address that isn't a link, which Kompl refuses
 * whether or not the user lets agents add sources.
 * Exits 0 when every check passes, 1 otherwise.
 */

import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sdk = (path) => pathToFileURL(join(root, 'mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm', path)).href;
const { Client } = await import(sdk('client/index.js'));
const { StdioClientTransport } = await import(sdk('client/stdio.js'));

const EXPECTED_TOOLS = [
  'add_source',
  'list_sources',
  'read_page',
  'read_source',
  'recent_changes',
  'research_topic',
  'search_wiki',
  'wiki_status',
];

const client = new Client({ name: 'kompl-mcp-smoke', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'mcp-server/dist/index.js')],
    env: { ...process.env, KOMPL_URL: process.env.KOMPL_URL ?? 'http://localhost:3000' },
    stderr: 'inherit',
  })
);

let failed = 0;
function check(label, ok, detail) {
  console.log(`  ${ok ? 'ok  ' : 'FAIL'} ${label}${ok ? '' : `: ${detail}`}`);
  if (!ok) failed++;
}
async function run(name, args) {
  try {
    const result = await client.callTool({ name, arguments: args }, undefined, { timeout: 30_000 });
    return { text: result.content.map((c) => c.text ?? '').join('\n'), isError: result.isError === true };
  } catch (err) {
    // A call that throws (timeout, server crash) fails its check, not the run.
    return { text: `call threw: ${err instanceof Error ? err.message : String(err)}`, isError: null };
  }
}

const names = (await client.listTools()).tools.map((t) => t.name).sort();
check('the eight tools are listed', JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS), names.join(', '));
check('server instructions are sent', (client.getInstructions() ?? '').includes('[n]'), 'missing');

const status = await run('wiki_status', {});
check('wiki_status answers', status.isError === false && status.text.includes('Kompl wiki status'), status.text.slice(0, 200));

const browse = await run('search_wiki', {});
check('search_wiki browses without a query', browse.isError === false, browse.text.slice(0, 200));

const search = await run('search_wiki', { query: 'test' });
check('search_wiki searches', search.isError === false, search.text.slice(0, 200));

const missing = await run('read_page', { page_id: 'no-such-page-mcp-smoke' });
check(
  'read_page flags an unknown page as an error',
  missing.isError === true && missing.text.includes('Page not found'),
  missing.text.slice(0, 200)
);

const noSource = await run('read_source', { source_id: 'no-such-source-mcp-smoke' });
check(
  'read_source flags an unknown source as an error',
  noSource.isError === true && noSource.text.includes('No source'),
  noSource.text.slice(0, 200)
);

const changes = await run('recent_changes', { days: 1 });
check('recent_changes answers', changes.isError === false, changes.text.slice(0, 200));

const research = await run('research_topic', { topic: 'test' });
check('research_topic answers', research.isError === false, research.text.slice(0, 200));

const sources = await run('list_sources', { limit: 1 });
check('list_sources answers', sources.isError === false, sources.text.slice(0, 200));

// Not a link: refused as "turned off" (the default) or, if the user has let
// agents add sources, as not a link. Nothing is staged either way.
const add = await run('add_source', { urls: ['mcp-smoke:not-a-link'] });
check(
  'add_source refuses without adding anything',
  add.isError === true && (add.text.includes('turned off') || add.text.includes('Not an http(s) link')),
  add.text.slice(0, 200)
);

await client.close();
console.log(failed ? `  ${failed} MCP check(s) failed` : '  all MCP checks passed');
process.exit(failed ? 1 : 0);
