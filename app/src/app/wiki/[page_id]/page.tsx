// Disable static prerendering — reads from SQLite which only exists at runtime.
export const dynamic = 'force-dynamic';

/**
 * /wiki/[page_id] — Enhanced wiki page view. SERVER component.
 *
 * Three-column layout:
 *   Left  — WikiSidebar (category tree, graph link, search)
 *   Center — Compiled markdown body
 *   Right  — TOC (from ## headings) + Backlinks panel
 *
 * YAML frontmatter in the markdown file is stripped before rendering.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';

import WikiPageHeader from '../../../components/WikiPageHeader';
import {
  getDb,
  getCategoryGroups,
  getBacklinks,
  getPage,
  getPageTitleMap,
  getUnresolvedLinks,
  readPageMarkdown,
  type PageRow,
} from '../../../lib/db';
import {
  renderMarkdown,
  stripFrontmatter,
  stripWrappingFence,
  stripSourcesSection,
  stripLeadingContentHeading,
} from '../../../lib/markdown';
import WikiSidebar from '../../../components/WikiSidebar';
import SavedLinksInteractive from './SavedLinksInteractive';

const SAVED_LINKS_PAGE_ID = 'saved-links';

interface PageProps {
  params: Promise<{ page_id: string }>;
}

const PAGE_TYPE_BADGE: Record<string, { label: string; color: string }> = {
  'source-summary': { label: 'source summary', color: 'var(--fg-dim)' },
  concept: { label: 'concept', color: 'var(--accent)' },
  entity: { label: 'entity', color: 'var(--warning)' },
  comparison: { label: 'comparison', color: 'var(--danger)' },
  overview: { label: 'overview', color: 'var(--success)' },
};

function formatDate(iso: string): string {
  const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 10);
}

/**
 * Expand [[Page Title]] wikilinks to markdown links.
 * Unknown titles render as plain text (no broken link).
 */
function expandWikilinks(md: string, titleMap: Map<string, string>): string {
  return md.replace(/\[\[([^\]]+)\]\]/g, (_match, title: string) => {
    const pageId = titleMap.get(title.toLowerCase());
    if (pageId) return `[${title}](/wiki/${pageId})`;
    return title;
  });
}

/** Extract headings for TOC: returns [{level, text, anchor}] */
function extractHeadings(md: string): { level: number; text: string; anchor: string }[] {
  const headings: { level: number; text: string; anchor: string }[] = [];
  for (const line of md.split('\n')) {
    const m = line.match(/^(#{2,3})\s+(.+)$/);
    if (m) {
      const text = m[2].trim();
      const anchor = text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
      headings.push({ level: m[1].length, text, anchor });
    }
  }
  return headings;
}

/** Parse entities from YAML frontmatter. */
function parseFrontmatterEntities(md: string): string[] {
  if (!md.startsWith('---\n')) return [];
  const end = md.indexOf('\n---\n', 4);
  if (end === -1) return [];
  const front = md.slice(4, end);
  const m = front.match(/^entities:\s*\[(.+)\]/m);
  if (!m) return [];
  return m[1]
    .split(',')
    .map((s) => s.trim().replace(/^"|"$/g, ''))
    .filter(Boolean);
}

/** Collapsible panel that loads and renders the previous version of a page. */
async function PreviousVersionPanel({ pageId, lastUpdated }: { pageId: string; lastUpdated: string }) {
  const res = await fetch(
    `${process.env.APP_URL ?? 'http://app:3000'}/api/wiki/${pageId}/previous`,
    { cache: 'no-store' }
  ).catch(() => null);

  if (!res || !res.ok) {
    return <p style={{ color: 'var(--fg-dim)', fontSize: 12, marginTop: '0.5rem' }}>Previous version unavailable.</p>;
  }

  const data = (await res.json()) as { content: string };
  const prevHtml = renderMarkdown(stripFrontmatter(data.content));

  return (
    <div
      style={{
        marginTop: '0.75rem',
        padding: '1rem 1.25rem',
        borderRadius: 6,
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        opacity: 0.75,
      }}
    >
      <div className="meta" style={{ marginBottom: '0.5rem' }}>
        Previous version · before {formatDate(lastUpdated)}
      </div>
      <article dangerouslySetInnerHTML={{ __html: prevHtml }} style={{ fontSize: 13 }} />
    </div>
  );
}

/**
 * Contradicting sources panel — rendered next to the Linked resources block
 * on the right sidebar. Reads activity_log rows (via /api/wiki/[page_id]/contradictions)
 * where the match-step LLM triage flagged a source as contradicting this page.
 * Read-only for now; resolve/dismiss verbs and an inbox view are deferred
 * until real usage tells us the right UI shape.
 */
interface ContradictionItem {
  source_id: string | null;
  source_title: string | null;
  source_url: string | null;
  source_type: string | null;
  date_ingested: string | null;
  reason: string | null;
  session_id: string | null;
  detected_at: string | null;
}

async function ContradictingSourcesPanel({ pageId }: { pageId: string }) {
  const res = await fetch(
    `${process.env.APP_URL ?? 'http://app:3000'}/api/wiki/${pageId}/contradictions`,
    { cache: 'no-store' }
  ).catch(() => null);

  if (!res || !res.ok) return null;

  const data = (await res.json()) as { items: ContradictionItem[]; count: number };
  if (data.count === 0) return null;

  return (
    <section style={{ marginTop: '2rem' }}>
      <div className="meta" style={{ marginBottom: '0.5rem' }}>
        Contradicting sources
      </div>
      {data.items.map((item, idx) => {
        const key = `${item.source_id ?? 'unknown'}-${item.detected_at ?? idx}`;
        const label = item.source_title ?? item.source_url ?? 'Untitled source';
        const href = item.source_id ? `/source/${item.source_id}` : null;
        return (
          <div
            key={key}
            style={{
              fontSize: 12,
              padding: '0.3em 0',
              lineHeight: 1.4,
              borderBottom: '1px solid var(--border)',
            }}
          >
            {href ? (
              <Link
                href={href}
                style={{
                  display: 'block',
                  color: 'var(--danger)',
                  fontWeight: 500,
                }}
              >
                {label}
              </Link>
            ) : (
              <span style={{ color: 'var(--danger)', fontWeight: 500 }}>{label}</span>
            )}
            {item.reason && (
              <div style={{ color: 'var(--fg-dim)', marginTop: '0.2em' }}>{item.reason}</div>
            )}
            {(item.source_type || item.date_ingested) && (
              <div style={{ color: 'var(--fg-muted)', marginTop: '0.2em', fontSize: 11 }}>
                {item.source_type ? item.source_type : ''}
                {item.source_type && item.date_ingested ? ' · ' : ''}
                {item.date_ingested ? formatDate(item.date_ingested) : ''}
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
}

/** Related pages panel — embedding similarity, zero LLM cost. */
async function RelatedPagesPanel({ pageId }: { pageId: string }) {
  const res = await fetch(
    `${process.env.APP_URL ?? 'http://app:3000'}/api/wiki/${pageId}/related`,
    { cache: 'no-store' }
  ).catch(() => null);

  if (!res || !res.ok) return null;

  const data = (await res.json()) as {
    items: Array<{ page_id: string; title: string; page_type: string }>;
    count: number;
    enabled: boolean;
  };

  if (!data.enabled || data.count === 0) return null;

  return (
    <section style={{ marginTop: '2rem' }}>
      <div className="meta" style={{ marginBottom: '0.5rem' }}>
        You might also read
      </div>
      {data.items.map((p) => (
        <Link
          key={p.page_id}
          href={`/wiki/${p.page_id}`}
          style={{
            display: 'block',
            fontSize: 12,
            color: 'var(--fg-muted)',
            padding: '0.2em 0',
            lineHeight: 1.4,
          }}
        >
          {p.title}
        </Link>
      ))}
    </section>
  );
}

export default async function WikiPageDetail({ params }: PageProps) {
  const { page_id } = await params;
  const page: PageRow | null = getPage(page_id);
  if (!page) notFound();

  const rawMarkdown = readPageMarkdown(page_id);
  const entities = rawMarkdown ? parseFrontmatterEntities(rawMarkdown) : [];
  const strippedMarkdown = rawMarkdown ? stripFrontmatter(rawMarkdown) : null;
  const titleMap = getPageTitleMap();
  // Heal legacy drafts: unwrap body-only code fences, drop duplicate `## Sources`
  // section (provenance footer below owns it), then expand wikilinks.
  const cleanMarkdown = strippedMarkdown
    ? expandWikilinks(
        stripLeadingContentHeading(
          stripSourcesSection(stripWrappingFence(strippedMarkdown)),
        ),
        titleMap,
      )
    : null;
  const headings = cleanMarkdown ? extractHeadings(cleanMarkdown) : [];
  const html = cleanMarkdown ? renderMarkdown(cleanMarkdown) : null;

  const groups = getCategoryGroups();
  const backlinks = getBacklinks(page_id);

  const db = getDb();
  const provRows = db
    .prepare(
      `SELECT p.source_id, s.title AS source_title, s.source_url, p.date_compiled
         FROM provenance p
         JOIN sources s ON s.source_id = p.source_id
         WHERE p.page_id = ?
         ORDER BY p.date_compiled DESC`
    )
    .all(page_id) as Array<{
    source_id: string;
    source_title: string;
    source_url: string | null;
    date_compiled: string;
  }>;

  const badge = PAGE_TYPE_BADGE[page.page_type];

  return (
    <div style={{ display: 'flex', minHeight: 'calc(100dvh / 0.9)' }}>
      <WikiSidebar
        initialGroups={groups}
        activePageId={page_id}
        activeCategory={page.category ?? undefined}
      />

      {/* Center: page content */}
      <main style={{ flex: 1, padding: '2rem 2.5rem', minWidth: 0 }}>
        <WikiPageHeader
          title={page.title}
          category={page.category}
          lastUpdated={page.last_updated}
          showActions
        />

        {/* Sub-header: type badge + source count */}
        <div style={{ marginTop: '-1rem', marginBottom: '1.75rem' }}>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap', alignItems: 'center', fontSize: 13, color: 'var(--fg-muted)' }}>
            {badge && (
              <span
                className="meta"
                style={{ border: `1px solid ${badge.color}`, color: badge.color, padding: '0.1em 0.55em', borderRadius: 999 }}
              >
                {badge.label}
              </span>
            )}
            <span className="meta">{page.source_count} source{page.source_count !== 1 ? 's' : ''}</span>
          </div>
        </div>

        {(page.summary || entities.length > 0) && (
          <section style={{ marginBottom: '2rem' }}>
            <div style={{ marginBottom: '0.75rem', paddingBottom: '0.4rem', borderBottom: '1px solid var(--border)' }}>
              <span className="meta" style={{ fontWeight: 600, fontSize: 12, color: 'var(--fg-dim)', letterSpacing: '0.08em' }}>
                OVERVIEW
              </span>
            </div>
            {page.summary && (
              <p style={{ margin: '0 0 0.75rem', color: 'var(--fg-muted)', lineHeight: 1.6, fontSize: 15 }}>
                {page.summary}
              </p>
            )}
            {entities.length > 0 && (
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
                {entities.map((name) => (
                  <span
                    key={name}
                    style={{ background: 'var(--bg-card)', border: '1px solid var(--border-hover)', padding: '0.15em 0.6em', borderRadius: 4, fontSize: 12, color: 'var(--fg-muted)' }}
                  >
                    {name}
                  </span>
                ))}
              </div>
            )}
          </section>
        )}

        {page_id === SAVED_LINKS_PAGE_ID ? (
          <SavedLinksInteractive initialLinks={getUnresolvedLinks()} />
        ) : html ? (
          <section>
            <div style={{ marginBottom: '1rem', paddingBottom: '0.4rem', borderBottom: '1px solid var(--border)' }}>
              <span className="meta" style={{ fontWeight: 600, fontSize: 12, color: 'var(--fg-dim)', letterSpacing: '0.08em' }}>
                CONTENT
              </span>
            </div>
            <article dangerouslySetInnerHTML={{ __html: html }} style={{ fontSize: 14 }} />
          </section>
        ) : (
          <div
            style={{
              background: 'var(--bg-card)',
              border: '1px solid var(--danger)',
              color: 'var(--danger)',
              padding: '1em 1.2em',
              borderRadius: 6,
            }}
          >
            <strong>Page file missing.</strong> The page row exists but{' '}
            <code>{page.content_path}</code> is not readable.
          </div>
        )}

        {/* Provenance footer */}
        {provRows.length > 0 && (
          <footer
            style={{
              marginTop: '3rem',
              paddingTop: '1.5rem',
              borderTop: '1px solid var(--border)',
              color: 'var(--fg-muted)',
              fontSize: 12,
            }}
          >
            <div className="meta" style={{ fontWeight: 600, marginBottom: '0.4rem' }}>
              BUILT FROM {provRows.length} SOURCE{provRows.length !== 1 ? 'S' : ''}
            </div>
            {provRows.map((r) => (
              <div key={r.source_id} style={{ marginBottom: '0.25rem' }}>
                <Link href={`/source/${r.source_id}`}>{r.source_title}</Link>
                {r.source_url && (
                  <>
                    {' '}
                    &mdash;{' '}
                    <a href={r.source_url} target="_blank" rel="noopener noreferrer">
                      original
                    </a>
                  </>
                )}
                <span className="meta" style={{ marginLeft: '0.5rem' }}>
                  {formatDate(r.date_compiled)}
                </span>
              </div>
            ))}
            {page.previous_content_path && (
              <details style={{ marginTop: '1rem' }}>
                <summary
                  style={{ cursor: 'pointer', color: 'var(--fg-dim)', userSelect: 'none' }}
                >
                  View previous version
                </summary>
                <PreviousVersionPanel pageId={page_id} lastUpdated={page.last_updated} />
              </details>
            )}
          </footer>
        )}
      </main>

      {/* Right: TOC + Backlinks */}
      <aside
        style={{
          width: 242,
          flexShrink: 0,
          padding: '2rem 1rem',
          borderLeft: '1px solid var(--border)',
          fontSize: 13,
          position: 'sticky',
          top: 0,
          maxHeight: 'calc(100dvh / 0.9)',
          overflowY: 'auto',
          alignSelf: 'flex-start',
        }}
      >
        {headings.length > 0 && (
          <section style={{ marginBottom: '2rem' }}>
            <div className="meta" style={{ marginBottom: '0.5rem' }}>
              Contents
            </div>
            {headings.map((h) => (
              <a
                key={h.anchor}
                href={`#${h.anchor}`}
                style={{
                  display: 'block',
                  paddingLeft: h.level === 3 ? '1em' : 0,
                  color: 'var(--fg-muted)',
                  fontSize: 12,
                  padding: `0.2em 0 0.2em ${h.level === 3 ? '0.8em' : '0'}`,
                  lineHeight: 1.4,
                }}
              >
                {h.text}
              </a>
            ))}
          </section>
        )}

        <section>
          <div className="meta" style={{ marginBottom: '0.5rem' }}>
            Linked from ({backlinks.length})
          </div>
          {backlinks.length === 0 ? (
            <p style={{ color: 'var(--fg-dim)', fontSize: 12, margin: 0 }}>No inbound links yet.</p>
          ) : (
            backlinks.map((b) => (
              <Link
                key={b.page_id}
                href={`/wiki/${b.page_id}`}
                style={{
                  display: 'block',
                  fontSize: 12,
                  color: 'var(--fg-muted)',
                  padding: '0.2em 0',
                  lineHeight: 1.4,
                }}
              >
                {b.title}
              </Link>
            ))
          )}
        </section>

        {page.page_type === 'source-summary' && provRows[0] && (
          <section style={{ marginTop: '2rem' }}>
            <Link
              href={`/source/${provRows[0].source_id}`}
              style={{
                display: 'block',
                fontSize: 17,
                fontWeight: 500,
                color: 'var(--accent)',
                padding: '0.25em 0',
                lineHeight: 1.4,
              }}
            >
              View original →
            </Link>
          </section>
        )}

        <ContradictingSourcesPanel pageId={page_id} />
        <RelatedPagesPanel pageId={page_id} />
      </aside>
    </div>
  );
}
