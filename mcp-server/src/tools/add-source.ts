import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KomplClient } from '../kompl-client.js';
import { failure, text } from '../result.js';
import type { AddSourceAnswer } from '../types.js';

// POST /api/agent/sources. The app enforces every rule (switch, limits, a
// running compile); this tool only explains its answers.
export function registerAddSource(server: McpServer, client: KomplClient): void {
  server.registerTool(
    'add_source',
    {
      title: 'Add source',
      description:
        "Save links or a note to the user's Kompl wiki. Kompl fetches each link and compiles it into cited wiki " +
        "pages. Each addition starts a compile that uses the user's AI model and counts toward their daily spend " +
        'cap, so add only what the user asked for. Off unless the user turned it on in Kompl (Settings → Connect ' +
        'your AI); up to 5 links per call. Check list_sources first if a link may already be saved. Follow the ' +
        'compile with recent_changes and the session_id this returns.',
      inputSchema: {
        urls: z.array(z.string()).min(1).max(5).optional().describe('Links to add (http or https), up to 5'),
        text: z.string().optional().describe('Or: a note to keep as a source, such as a decision or summary'),
        title: z.string().optional().describe('Title for the note (optional; defaults to its first line)'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
    },
    async ({ urls, text: note, title }) => {
      const agent = server.server.getClientVersion()?.name;
      const res = await client.post<AddSourceAnswer>(
        '/api/agent/sources',
        { ...(urls ? { urls } : {}), ...(note !== undefined ? { text: note, title } : {}), client: agent },
        // Starting a compile can take a while when n8n is slow to answer.
        { slow: true }
      );
      if (!res.ok) {
        if (res.timedOut) {
          // No full answer in time (even after a 200): Kompl may have saved them anyway, and a resend would be a duplicate.
          return failure(
            'Kompl did not answer in time. The sources may have been saved anyway: check recent_changes or list_sources before sending them again.'
          );
        }
        if (res.status === 404 && res.message === 'HTTP 404') {
          return failure("This Kompl app can't take sources from agents yet. Run `kompl update`.");
        }
        if (res.status === 503) {
          return failure(
            `Kompl saved the items but could not start the compile (${res.message}). The user can retry it from the Kompl app.`
          );
        }
        return failure(res.message);
      }
      return text(format(res.data));
    }
  );
}

function format(a: AddSourceAnswer): string {
  const lines = a.added
    ? [
        `Added ${a.added} source(s) to Kompl; compiling now (session \`${a.session_id}\`).`,
        `Follow it with recent_changes and session_id "${a.session_id}".`,
      ]
    : ['Nothing new to add.'];
  if (a.already_in_wiki.length) {
    lines.push(`Already in Kompl: ${a.already_in_wiki.map((s) => `${s.url} (source \`${s.source_id}\`)`).join(', ')}`);
  }
  if (a.blocked.length) lines.push(`Skipped (sites Kompl can't read): ${a.blocked.join(', ')}`);
  return lines.join('\n');
}
