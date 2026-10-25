import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { KomplClient } from '../kompl-client.js';
import { fence } from '../fence.js';
import { clip } from '../format.js';
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
        'contradictions from the last health check; plus the topic clusters of the knowledge graph and the ' +
        'bridge pages that join topics. Reports only; changes nothing.',
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

  // From here on the lines name pages, sources and claims: wiki text, inside the fence (fence.ts).
  const g = s.gaps;
  const wiki = ['**Gaps** (read from the wiki; nothing was changed)'];
  wiki.push(
    gap(
      'Named in 3+ sources but no page',
      g.missing_pages,
      (m) => `${m.name} (${m.mentions} sources)`,
      g.missing_pages.capped ? '+' : ''
    )
  );
  wiki.push(gap('Pages resting on one source', g.thin_pages, (p) => `${p.title} (\`${p.page_id}\`, linked from ${p.backlinks})`));
  wiki.push(gap('Pages with no links in or out', g.orphan_pages, (p) => `${p.title} (\`${p.page_id}\`)`));
  wiki.push(
    gap(`Sources older than ${s.stale_sources.threshold_days} days`, s.stale_sources, (x) => `${x.title} (added ${x.date_ingested.slice(0, 10)})`)
  );
  wiki.push(gap('Failed imports', s.failed_links, (l) => `${l.url} — ${clip(l.error, 120)}`));
  if (g.dead_provenance.count) wiki.push(`• Citations to deleted sources: ${g.dead_provenance.count}`);
  wiki.push(
    s.last_health_check
      ? gap(
          `Contradictions found by the last health check (${s.last_health_check.at ?? 'date unknown'})`,
          s.last_health_check.contradictions,
          (c) => `${c.page_a} vs ${c.page_b}: ${clip(c.claim, 200)}`
        )
      : '• No health check has been run yet. The user can run one in Settings → Wiki health (it uses the LLM).'
  );
  // Older apps send neither.
  if (s.clusters) wiki.push('', ...clusterLines(s.clusters));
  if (s.bridges) wiki.push(...bridgeLines(s.bridges));
  return [...lines, '', fence(wiki.join('\n'))].join('\n');
}

function clusterLines(clusters: NonNullable<WikiStatus['clusters']>): string[] {
  if (!clusters.count) return ['**Topic clusters:** none yet.'];
  const more = clusters.count - clusters.top.length;
  return [
    '**Topic clusters** (categories on the knowledge graph: their pages, not counting source pages, and the typed connections inside each)',
    ...clusters.top.map((c) => `• ${c.name}: ${plural(c.pages, 'page')}, ${plural(c.connections, 'connection')} inside`),
    ...(more > 0 ? [`• and ${plural(more, 'more topic')}`] : []),
  ];
}

function bridgeLines(bridges: NonNullable<WikiStatus['bridges']>): string[] {
  if (!bridges.length) return ['**Bridge pages:** none yet (no page sits between pages of two or more topics).'];
  return [
    '**Bridge pages** (on many of the shortest ways between pages of different topics)',
    ...bridges.map((b) => `• ${b.title} (\`${b.page_id}\`, ${b.category}) joins ${topicList(b.joins)}`),
  ];
}

function plural(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? '' : 's'}`;
}

/** "AI", "AI and Crypto", "AI, Crypto and Travel" */
function topicList(topics: string[]): string {
  if (topics.length < 2) return topics[0] ?? '';
  return `${topics.slice(0, -1).join(', ')} and ${topics[topics.length - 1]}`;
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
