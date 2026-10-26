#!/usr/bin/env node
/**
 * MCP smoke check: launch the built MCP server over stdio the way an AI
 * agent does and call every tool against a running Kompl app. Used by
 * integration-test.sh stage 28; also handy by hand after `kompl start`:
 *
 *   node scripts/mcp-smoke.mjs            (KOMPL_URL defaults to localhost:3000)
 *
 * Besides "the tool answers", it checks shapes: each app route the tools
 * read must have the fields of the contract fixture
 * (mcp-server/test/contract/app-responses.json, compared by
 * json-shape.mjs), and the tools must show the page and source the app
 * lists first under their own titles and ids.
 *
 * Needs mcp-server built (npm ci && npm run build in mcp-server/). Changes
 * nothing: add_source gets an address that isn't a link, which Kompl refuses
 * whether or not the user lets agents add sources.
 * Exits 0 when every check passes, 1 otherwise.
 */

import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const sdk = (path) => pathToFileURL(join(root, 'mcp-server/node_modules/@modelcontextprotocol/sdk/dist/esm', path)).href;
const { Client } = await import(sdk('client/index.js'));
const { StdioClientTransport } = await import(sdk('client/stdio.js'));
const contractDir = join(root, 'mcp-server/test/contract');
const { compareShape } = await import(pathToFileURL(join(contractDir, 'json-shape.mjs')).href);
const contract = JSON.parse(readFileSync(join(contractDir, 'app-responses.json'), 'utf-8'));

const KOMPL_URL = (process.env.KOMPL_URL ?? 'http://localhost:3000').replace(/\/+$/, '');
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
/** Signs that a tool printed a field the app no longer sends, or under another name. */
const BROKEN = /undefined|NaN|\[object Object\]/;

const client = new Client({ name: 'kompl-mcp-smoke', version: '1.0.0' });
await client.connect(
  new StdioClientTransport({
    command: process.execPath,
    args: [join(root, 'mcp-server/dist/index.js')],
    env: { ...process.env, KOMPL_URL },
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
/** A tool answer that worked and printed no missing field. */
function answered(label, res, ...pieces) {
  const missing = pieces.filter((p) => !res.text.includes(p));
  const ok = res.isError === false && !BROKEN.test(res.text) && !missing.length;
  check(label, ok, missing.length ? `missing ${JSON.stringify(missing)} in ${res.text.slice(0, 200)}` : res.text.slice(0, 200));
}
/**
 * GET an app route and hold its JSON to the contract entry's shape; returns
 * the body. `skip(status, body)` names an answer that is fine but has nothing
 * to check (e.g. a source whose text is missing).
 */
async function shaped(entry, path, skip = () => null) {
  let status = null;
  let body = null;
  try {
    const res = await fetch(KOMPL_URL + path, { signal: AbortSignal.timeout(30_000) });
    status = res.status;
    body = await res.json();
  } catch (err) {
    check(`${path} answers`, false, err instanceof Error ? err.message : String(err));
    return null;
  }
  const why = skip(status, body);
  if (why) {
    console.log(`  skip ${path}: ${why}`);
    return null;
  }
  const { errors, unverified } = compareShape(contract[entry].body, body);
  const note = unverified.length ? ` (empty here, not checked: ${unverified.join(', ')})` : '';
  check(`${path} has the fields the tools read${note}`, status === 200 && !errors.length, `HTTP ${status}; ${errors.join('; ')}`);
  return body;
}

const names = (await client.listTools()).tools.map((t) => t.name).sort();
check('the eight tools are listed', JSON.stringify(names) === JSON.stringify(EXPECTED_TOOLS), names.join(', '));
check('server instructions are sent', (client.getInstructions() ?? '').includes('[n]'), 'missing');

// The routes behind the tools, by shape.
const status = await shaped('status', '/api/wiki/status');
const index = await shaped('wiki_index', '/api/wiki/index');
const list = await shaped('source_list', '/api/sources?limit=5');
await shaped('changes_since', '/api/wiki/changes?days=30');
await shaped('search', '/api/pages/search?q=test&mode=hybrid');
await shaped('research', '/api/wiki/research?topic=test');
const page = index?.pages?.find((p) => p.page_id !== 'saved-links');
const source = list?.sources?.[0];
if (page) {
  await shaped('page_data', `/api/wiki/${encodeURIComponent(page.page_id)}/data`);
  await shaped('changes_page', `/api/wiki/changes?page_id=${encodeURIComponent(page.page_id)}`);
}
const sourceText =
  source &&
  (await shaped('source_text', `/api/sources/${encodeURIComponent(source.source_id)}/content`, (code, body) =>
    code === 404 && body?.error === 'no_text' ? 'its stored text is missing' : null
  ));

// The tools, on the same data.
answered('wiki_status answers', await run('wiki_status', {}), '**Kompl wiki status**', '• Sources: ', ' · Pages: ');
check('the status route answered', status !== null, 'see above');
answered('search_wiki browses without a query', await run('search_wiki', {}), ...(page ? [`ID: \`${page.page_id}\``] : []));
answered('search_wiki searches', await run('search_wiki', { query: 'test' }));
answered('recent_changes answers', await run('recent_changes', { days: 1 }));
answered('research_topic answers', await run('research_topic', { topic: 'test' }));
answered('list_sources answers', await run('list_sources', { limit: 1 }), ...(source ? [`ID: \`${source.source_id}\``] : []));
if (page) answered('read_page shows the first page', await run('read_page', { page_id: page.page_id }), `# ${page.title}\n`, `Type: ${page.page_type}`);
if (sourceText) answered('read_source shows the first source', await run('read_source', { source_id: source.source_id }), `# ${source.title}\n`);

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

const badId = await run('read_source', { source_id: '..' });
check(
  'read_source refuses an id that is not one',
  badId.isError === true && badId.text.includes('source_id must be a Kompl source id'),
  badId.text.slice(0, 200)
);

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
