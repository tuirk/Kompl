import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KomplClient, type KomplClientOptions } from './kompl-client.js';
import { registerReadPage } from './tools/read-page.js';
import { registerSearchWiki } from './tools/search-wiki.js';
import { registerWikiStats } from './tools/wiki-stats.js';

export const SERVER_NAME = 'kompl-wiki';
/** Keep in step with package.json "version". */
export const SERVER_VERSION = '1.0.0';

/**
 * Sent to the client at connect time; clients that support server
 * instructions pass it to the model. Keep it short (some clients truncate
 * around 2k characters) and keep it true for every tool registered below.
 */
export const SERVER_INSTRUCTIONS = [
  "Kompl is the user's personal wiki, compiled from sources they saved (articles, bookmarks, documents).",
  'Each page cites its sources with [n] markers that map to the numbered source list read_page returns.',
  '- Find pages with search_wiki (ask in plain language; leave the query out to browse), then read them with read_page before answering.',
  '- When you answer from Kompl, name the pages you used and keep the [n] source references so the user can check each claim.',
  "- If Kompl has nothing on a topic, say so instead of silently filling the gap from general knowledge.",
].join('\n');

/** Build the MCP server. Transport-agnostic: the caller connects it (stdio today). */
export function createServer(options: KomplClientOptions): McpServer {
  const client = new KomplClient(options);
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: SERVER_INSTRUCTIONS }
  );
  registerSearchWiki(server, client);
  registerReadPage(server, client);
  registerWikiStats(server, client);
  return server;
}
