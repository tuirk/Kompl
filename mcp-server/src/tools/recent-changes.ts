import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KomplClient } from '../kompl-client.js';
import { fence } from '../fence.js';
import { failure, READ_ONLY, text } from '../result.js';
import type { AddedSource, ChangedPage, Changes, DisputeEvent, WikiEvent } from '../types.js';

// GET /api/wiki/changes?days|since|session_id|page_id&limit
export function registerRecentChanges(server: McpServer, client: KomplClient): void {
  server.registerTool(
    'recent_changes',
    {
      title: 'Recent changes',
      description:
        "What changed in the user's Kompl wiki: sources added, pages created or updated (with the sources " +
        'behind each change), disagreements recorded (disputed or changed claims, sources flagged as contradicting a ' +
        'page) and imports that failed, over the last N days or since a time. ' +
        "With session_id (shown next to each added source), follows one compile. With page_id, one page's history: the " +
        'compiles that fed it and which sections changed since its previous version.',
      inputSchema: {
        days: z.number().int().min(1).max(365).optional().describe('Look back this many days (default 7)'),
        since: z.string().optional().describe('Or: changes since this date/time, e.g. 2026-10-01 (UTC)'),
        session_id: z.string().optional().describe('Or: one compile session'),
        page_id: z.string().optional().describe("Or: one page's history"),
        limit: z.number().int().min(1).max(100).default(20).describe('Max items per list (default 20)'),
      },
      annotations: READ_ONLY,
    },
    async ({ days, since, session_id, page_id, limit }) => {
      const page = page_id?.trim() || undefined;
      const session = session_id?.trim() || undefined;
      const from = since?.trim() || undefined;
      const res = await client.get<Changes>('/api/wiki/changes', {
        page_id: page,
        session_id: page ? undefined : session,
        since: page || session ? undefined : from,
        days: page || session || from ? undefined : days,
        limit,
      });
      if (!res.ok) {
        if (res.status === 404 && res.message === 'HTTP 404') {
          return failure("This Kompl app can't report changes yet. Run `kompl update`.");
        }
        return failure(`Changes unavailable: ${res.message}`);
      }
      const c = res.data;
      return text(c.mode === 'page' ? formatPage(c) : c.mode === 'session' ? formatSession(c) : formatSince(c));
    }
  );
}

function formatSince(c: Extract<Changes, { mode: 'since' }>): string {
  const empty = !c.sources_added.total && !c.pages.total && !c.disputes.total && !c.failures.total;
  if (empty) return `No changes since ${c.since} UTC.`;
  return withWikiText(`**Changes since ${c.since} UTC**`, [
    section(`Sources added`, c.sources_added.items, c.sources_added.total, sourceLine),
    section('Pages created or updated', c.pages.items, c.pages.total, pageLine),
    section('Disagreements recorded', c.disputes.items, c.disputes.total, disputeLine),
    section('Failures', c.failures.items, c.failures.total, eventLine),
  ]);
}

function formatSession(c: Extract<Changes, { mode: 'session' }>): string {
  const when = [c.started_at && `started ${c.started_at}`, c.completed_at && `finished ${c.completed_at}`].filter(Boolean);
  const head = `**Compile session \`${c.session_id}\`**: ${c.status ?? 'not started'}${c.current_step && c.status === 'running' ? ` (step: ${c.current_step})` : ''}${when.length ? `, ${when.join(', ')} UTC` : ''}`;
  return withWikiText(head, [
    c.error ? `Error: ${c.error}` : '',
    section('Items', c.staged.items, c.staged.total, (s) => `${s.item}: ${s.status}${s.error ? ` (${s.error})` : ''}`),
    section('Sources added', c.sources_added.items, c.sources_added.total, sourceLine),
    section('Pages created or updated', c.pages.items, c.pages.total, pageLine),
    c.retries ? section('Retries pressed by the user (not automatic)', c.retries.items, c.retries.total, eventLine) : '',
    section('Failures', c.failures.items, c.failures.total, eventLine),
  ]);
}

/** Kompl's heading, then the sections that name titles and details from the wiki inside the fence (fence.ts). */
function withWikiText(head: string, sections: string[]): string {
  const filled = sections.filter(Boolean);
  return filled.length ? `${head}\n\n${fence(filled.join('\n\n'))}` : head;
}

function formatPage(c: Extract<Changes, { mode: 'page' }>): string {
  const p = c.page;
  const prev = c.previous_version;
  const diff = !prev
    ? 'no previous version is stored'
    : [
        prev.sections_added.length ? `added: ${prev.sections_added.join(', ')}` : '',
        prev.sections_removed.length ? `removed: ${prev.sections_removed.join(', ')}` : '',
        prev.sections_changed.length ? `changed: ${prev.sections_changed.join(', ')}` : '',
      ]
        .filter(Boolean)
        .join('; ') || 'no section changed (wording or citations only)';
  // Every line names the page, its sections or its sources: all of it is wiki text.
  return fence(
    [
      `**History of ${p.title}** (\`${p.page_id}\`, ${p.page_type}): created ${p.created_at}, last updated ${p.last_updated} UTC`,
      `Since the previous version: ${diff}.`,
      section('Compiles, newest first', c.compiles.items, c.compiles.total, (x) =>
        `${x.at}: ${x.contribution_type} from ${x.source_title ?? 'a deleted source'} (\`${x.source_id}\`)`
      ),
      section('Events', c.events.items, c.events.total, (e) => `${e.at}: ${humanize(e.kind)}${e.detail ? ` (${e.detail})` : ''}`),
    ]
      .filter(Boolean)
      .join('\n\n')
  );
}

function section<T>(label: string, items: T[], total: number, line: (item: T) => string): string {
  if (!total) return '';
  const more = total - items.length;
  return [`${label} (${total}):`, ...items.map((i) => `• ${line(i)}`), ...(more > 0 ? [`…and ${more} more`] : [])].join('\n');
}

function sourceLine(s: AddedSource): string {
  const pages = s.page_count ? `in ${s.page_count} page(s)` : 'in no pages yet';
  const session = s.onboarding_session_id ? `, session \`${s.onboarding_session_id}\`` : '';
  return `${s.title} (${s.source_type}, ${pages}, added ${s.date_ingested}${session})${s.source_url ? ` ${s.source_url}` : ''}`;
}

/** Sources named per changed page; the rest are counted. */
const SOURCES_SHOWN = 5;

function pageLine(p: ChangedPage): string {
  const names = p.sources.slice(0, SOURCES_SHOWN).map((s) => s.title ?? s.source_id);
  const more = p.source_total - names.length;
  const from = names.length ? ` from ${names.join(', ')}${more > 0 ? ` and ${more} more` : ''}` : '';
  return `${p.change === 'created' ? 'Created' : 'Updated'} **${p.title}** (\`${p.page_id}\`)${from}, ${p.at}`;
}

function eventLine(e: WikiEvent): string {
  const subject = e.page_title ?? e.source_title;
  return `${e.at}: ${humanize(e.kind)}${subject ? `, ${subject}` : ''}${e.detail ? ` (${e.detail})` : ''}`;
}

/** An event line, and whether the user confirmed it (newer apps; older ones send activity events). */
function disputeLine(e: DisputeEvent): string {
  const status = e.status === 'confirmed' ? ', confirmed by the user' : e.status ? ', not yet confirmed by the user' : '';
  return `${eventLine(e)}${status}`;
}

function humanize(kind: string): string {
  return kind.replace(/_/g, ' ');
}
