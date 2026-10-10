import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KomplClient } from '../kompl-client.js';
import { failure, READ_ONLY, text } from '../result.js';
import type { Summary, WikiStats, WikiStatus } from '../types.js';

// GET /api/wiki/status: read-only on the app side too (no LLM, no writes).
export function registerWikiStatus(server: McpServer, client: KomplClient): void {
  server.registerTool(
    'wiki_status',
    {
      title: 'Wiki status',
      description:
        "Overview of the user's Kompl wiki: its size, whether a compile is running, what waits for the user " +
        '(drafts to review, links that failed to import) and gaps worth filling: names mentioned in several ' +
        'sources with no page yet, pages resting on a single source, unlinked pages, old sources, and ' +
        'contradictions from the last health check. Reports only; changes nothing.',
      inputSchema: {},
      annotations: READ_ONLY,
    },
    async () => {
      const res = await client.get<WikiStatus>('/api/wiki/status');
      if (res.ok) return text(format(res.data));
      if (res.status === 404) return olderApp(client);
      return failure(`Status unavailable: ${res.message}`);
    }
  );
}

function format(s: WikiStatus): string {
  const st = s.stats;
  const waiting = [
    s.pending_drafts ? `${s.pending_drafts} draft(s) to review` : null,
    s.failed_links.count ? `${s.failed_links.count} link(s) failed to import` : null,
  ].filter(Boolean);
  const lines = [
    '**Kompl wiki status** (times in UTC)',
    `• Sources: ${st.source_count} active · Pages: ${st.page_count} (${st.entity_count} entities, ${st.concept_count} concepts)`,
    `• Last source added: ${st.last_ingested ?? 'never'} · Last compile: ${st.last_compiled ?? 'never'}`,
    s.compile_running
      ? `• Compile running: session \`${s.compile_running.session_id}\` with ${s.compile_running.source_count} source(s), started ${s.compile_running.started_at ?? 'just now'}`
      : '• No compile running',
    `• Waiting for the user: ${waiting.length ? waiting.join(' · ') : 'nothing'}`,
  ];
  if (s.vector_backlog) lines.push(`• ${s.vector_backlog} page(s) waiting to be added to meaning search`);

  const g = s.gaps;
  lines.push('', '**Gaps** (read from the wiki; nothing was changed)');
  lines.push(
    gap(
      'Named in 3+ sources but no page',
      g.missing_pages,
      (m) => `${m.name} (${m.mentions} sources)`,
      g.missing_pages.capped ? '+' : ''
    )
  );
  lines.push(gap('Pages resting on one source', g.thin_pages, (p) => `${p.title} (\`${p.page_id}\`, linked from ${p.backlinks})`));
  lines.push(gap('Pages with no links in or out', g.orphan_pages, (p) => `${p.title} (\`${p.page_id}\`)`));
  lines.push(
    gap(`Sources older than ${s.stale_sources.threshold_days} days`, s.stale_sources, (x) => `${x.title} (added ${x.date_ingested.slice(0, 10)})`)
  );
  lines.push(gap('Failed imports', s.failed_links, (l) => `${l.url} — ${clip(l.error, 120)}`));
  if (g.dead_provenance.count) lines.push(`• Citations to deleted sources: ${g.dead_provenance.count}`);
  lines.push(
    s.last_health_check
      ? gap(
          `Contradictions found by the last health check (${s.last_health_check.at ?? 'date unknown'})`,
          s.last_health_check.contradictions,
          (c) => `${c.page_a} vs ${c.page_b}: ${clip(c.claim, 200)}`
        )
      : '• No health check has been run yet. The user can run one in Settings → Wiki health (it uses the LLM).'
  );
  return lines.join('\n');
}

/** Raw upstream errors can be long JSON; the start says enough. */
function clip(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}

/** `plus` marks a count that stopped at the check's limit ("50+"). */
function gap<T>(label: string, summary: Summary<T>, show: (item: T) => string, plus = ''): string {
  if (!summary.count) return `• ${label}: none`;
  const more = summary.count - summary.top.length;
  return `• ${label} (${summary.count}${plus}): ${summary.top.map(show).join('; ')}${more > 0 ? `; and ${more}${plus} more` : ''}`;
}

/** Apps from before /api/wiki/status: the basic counts only. */
async function olderApp(client: KomplClient) {
  const res = await client.get<WikiStats>('/api/wiki/stats');
  if (!res.ok) return failure(`Status unavailable: ${res.message}`);
  const st = res.data;
  return text(
    [
      `**Kompl wiki status**`,
      `• Sources: ${st.source_count} active · Pages: ${st.page_count} (${st.entity_count} entities, ${st.concept_count} concepts)`,
      `• Last source added: ${st.last_ingested ?? 'never'} · Last compile: ${st.last_compiled ?? 'never'}`,
      '',
      '(This Kompl app is older than its MCP server, so gaps and pending work are not shown. Run `kompl update`.)',
    ].join('\n')
  );
}
