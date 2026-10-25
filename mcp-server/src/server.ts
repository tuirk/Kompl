import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { KomplClient, type KomplClientOptions } from './kompl-client.js';
import { registerAddSource } from './tools/add-source.js';
import { registerListSources } from './tools/list-sources.js';
import { registerReadPage } from './tools/read-page.js';
import { registerReadSource } from './tools/read-source.js';
import { registerRecentChanges } from './tools/recent-changes.js';
import { registerResearchTopic } from './tools/research-topic.js';
import { registerSearchWiki } from './tools/search-wiki.js';
import { registerWikiStatus } from './tools/wiki-status.js';

export const SERVER_NAME = 'kompl-wiki';
/** Keep in step with package.json "version". */
export const SERVER_VERSION = '2.0.0';

/**
 * Sent to the client at connect time; clients that support server
 * instructions pass it to the model. Keep it short (some clients truncate
 * around 2k characters) and keep it true for every tool registered below.
 */
export const SERVER_INSTRUCTIONS = [
  "Kompl is the user's personal wiki, compiled from sources they saved (articles, bookmarks, documents).",
  'Each page cites its sources with [n] markers that map to the numbered source list read_page returns.',
  '- For "tell me about X" or a briefing, start with research_topic: one call returns the key pages, cited lines and one shared source list.',
  '- For a specific lookup, find pages with search_wiki (ask in plain language; leave the query out to browse) and read them with read_page.',
  '- When you answer from Kompl, name the pages you used and keep the [n] source references so the user can check each claim.',
  '- read_page and research_topic also show how pages connect: each relation (uses, part of, created by...) with the source that says so.',
  "- To check what a source actually says, use read_source with the source_id from the source list (add a query to get the matching passages). research_topic's [n] numbers are its own, so always use its source_id; for read_page, page_id and n also work.",
  '- list_sources shows what the user has saved, e.g. whether a link is already in Kompl.',
  '- recent_changes answers "what is new / what changed"; wiki_status gives the overview and the gaps worth filling.',
  '- add_source saves links or notes the user asks you to keep. It starts a compile that costs the user money, so never add on your own initiative.',
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
  registerResearchTopic(server, client);
  registerReadPage(server, client);
  registerReadSource(server, client);
  registerListSources(server, client);
  registerRecentChanges(server, client);
  registerWikiStatus(server, client);
  registerAddSource(server, client);
  return server;
}
