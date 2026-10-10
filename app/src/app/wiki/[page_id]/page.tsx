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

import type { Metadata } from 'next';
import Link from 'next/link';
import { notFound } from 'next/navigation';

import WikiPageHeader from '../../../components/WikiPageHeader';
import { LocalDate } from '../../../components/LocalDate';
import {
  getCategoryGroups,
  getBacklinks,
  getPage,
  getPageTitleMap,
  getRunningCompileSession,
  getUnresolvedLinks,
  readPageMarkdown,
  type PageRow,
} from '../../../lib/db';
import PageActionButton from './PageActionButton';
import { healedPageBody, renderMarkdown } from '../../../lib/markdown';
import { expandWikilinksForDisplay } from '../../../lib/wiki-display';
import { removeEmptyContradictionSections, SYNTHESIZED_PAGE_TYPES } from '../../../lib/page-sections';
import WikiSidebar from '../../../components/WikiSidebar';
import SavedLinksInteractive from './SavedLinksInteractive';
import { PAGE_TYPE_VAR, PAGE_TYPE_LABELS, type PageType } from '../../../lib/page-type-palette';
import { renderInlineWikilinks } from '../../../lib/wikilink-render';
import { stripWikilinks } from '../../../lib/wikilink-syntax';
import {
  renderCitationMarkers,
  scanCitations,
  stripCitationPlaceholders,
} from '../../../lib/citations';
import { safeExternalUrl } from '../../../lib/safe-url';
import WikiToc, { type TocHeading } from '../../../components/WikiToc';
import { getNumberedSources, getSourceTitleSet } from '../../../lib/page-sources';

const SAVED_LINKS_PAGE_ID = 'saved-links';

interface PageProps {
  params: Promise<{ page_id: string }>;
}

function pageTypeBadge(t: string): { label: string; color: string } | undefined {
  const key = t as PageType;
  if (!(key in PAGE_TYPE_VAR)) return undefined;
  return { label: PAGE_TYPE_LABELS[key], color: PAGE_TYPE_VAR[key] };
}

export async function generateMetadata({ params }: PageProps): Promise<Metadata> {
  const { page_id } = await params;
  const page = getPage(page_id);
  if (!page) return { title: 'Page not found' };
  return { title: page.title, description: page.summary ?? undefined };
}

/**
 * Page body as displayed: healed legacy wrappers, and for pages the LLM
 * synthesizes, no Contradictions section that only says there are none.
 * Stored markdown is never changed.
 */
function displayBody(raw: string, pageType: string): string {
  const body = healedPageBody(raw);
  return SYNTHESIZED_PAGE_TYPES.has(pageType) ? removeEmptyContradictionSections(body).markdown : body;
}

/** Same slug rule as the heading renderer in lib/markdown.ts. */
function slugify(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9\s-]/g, '').replace(/\s+/g, '-');
}

/**
 * Extract ## and ### headings for the TOC. Skips fenced code blocks (a "# "
 * line in code is not a heading) and strips link syntax, emphasis and
 * citation markers from the displayed text. The anchor is slugged from the
 * raw heading source, exactly like the renderer, so the links land.
 */
function extractHeadings(md: string): TocHeading[] {
  const headings: TocHeading[] = [];
  let inFence = false;
  for (const line of md.split('\n')) {
    if (line.trimStart().startsWith('```')) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    const m = line.match(/^(#{2,3})\s+(.+?)(?:\s+#+)?\s*$/);
    if (!m) continue;
    const raw = m[2];
    const text = stripCitationPlaceholders(raw)
      .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
      .replace(/[*_`]/g, '')
      .trim();
    if (text) headings.push({ level: m[1].length, text, anchor: slugify(raw) });
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

/**
 * Collapsible panel that loads and renders the previous version of a page.
 * "Restore this version" shows only when that version can be read: a page
 * restored from a backup keeps the pointer, but backups don't carry the
 * archived file.
 */
async function PreviousVersionPanel({
  pageId,
  pageType,
  lastUpdated,
  restorable,
  restoreDisabledReason,
}: {
  pageId: string;
  pageType: string;
  lastUpdated: string;
  restorable: boolean;
  restoreDisabledReason: string | null;
}) {
  const res = await fetch(
    `${process.env.APP_URL ?? 'http://app:3000'}/api/wiki/${pageId}/previous`,
    { cache: 'no-store' }
  ).catch(() => null);

  if (!res || !res.ok) {
    return <p style={{ color: 'var(--fg-dim)', fontSize: 12, marginTop: '0.5rem' }}>Previous version unavailable.</p>;
  }

  const data = (await res.json()) as { content: string };
  // Citation numbers belong to the current version's source list, so the old
  // version shows its text without them; wikilinks become plain labels.
  const sourceTitles = getSourceTitleSet();
  const prevMarkdown = stripCitationPlaceholders(
    scanCitations(displayBody(data.content, pageType), (t) => sourceTitles.has(t.toLowerCase())).markdown,
  );
  const prevHtml = renderMarkdown(stripWikilinks(prevMarkdown));

  return (
    <>
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
          Previous version · before <LocalDate iso={lastUpdated} />
        </div>
        <article dangerouslySetInnerHTML={{ __html: prevHtml }} style={{ fontSize: 13 }} />
      </div>
      {restorable && (
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginTop: '0.75rem' }}>
          <PageActionButton
            endpoint={`/api/wiki/${pageId}/restore-previous`}
            label="Restore this version"
            busyLabel="Restoring…"
            confirmLabel="Restore"
            confirmText="Put this previous version back? The current version becomes the previous one, so you can switch back."
            disabledReason={restoreDisabledReason}
          />
        </div>
      )}
    </>
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
                {item.date_ingested ? <LocalDate iso={item.date_ingested} /> : ''}
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
  const titleMap = getPageTitleMap();
  const sourceTitles = getSourceTitleSet();

  // Heal legacy drafts (body-only code fences, duplicate `## Sources` — the
  // numbered source list below owns it), turn citations into numbered
  // placeholders, then expand wikilinks, linking each page once. Citations go
  // first: legacy citation groups can contain [[wikilinks]].
  const scan = rawMarkdown
    ? scanCitations(displayBody(rawMarkdown, page.page_type), (t) => sourceTitles.has(t.toLowerCase()))
    : null;
  const cleanMarkdown = scan
    ? expandWikilinksForDisplay(scan.markdown, (t) => titleMap.get(t.toLowerCase()), page_id)
    : null;
  const headings = cleanMarkdown ? extractHeadings(cleanMarkdown) : [];

  const groups = getCategoryGroups();
  const backlinks = getBacklinks(page_id);

  // Cited sources first (numbers match the markers), then the other sources.
  const sourceList = getNumberedSources(page_id, scan?.order ?? []);
  const html = cleanMarkdown
    ? renderCitationMarkers(
        renderMarkdown(cleanMarkdown),
        (n) => sourceList[n - 1]?.title ?? 'Source no longer in the wiki',
      )
    : null;

  const badge = pageTypeBadge(page.page_type);

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
              <p style={{ margin: '0 0 0.75rem', color: 'var(--fg-secondary)', lineHeight: 1.7, fontSize: 18, maxWidth: '70ch' }}>
                {renderInlineWikilinks(page.summary, titleMap)}
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
            <article dangerouslySetInnerHTML={{ __html: html }} style={{ fontSize: 18 }} />
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

        {/* Numbered sources — citation markers in the text link here (#src-N). */}
        {(sourceList.length > 0 || page.previous_content_path) && (
          <footer
            style={{
              marginTop: '3rem',
              paddingTop: '1.5rem',
              borderTop: '1px solid var(--border)',
              color: 'var(--fg-muted)',
              fontSize: 14,
            }}
          >
            {sourceList.length > 0 && (
              <>
                <h2 className="meta" style={{ fontWeight: 600, marginBottom: '0.6rem' }}>
                  Sources ({sourceList.length})
                </h2>
                <ol style={{ listStyle: 'none', padding: 0, margin: 0 }}>
                  {sourceList.map((r) => (
                    <li
                      key={r.source_id}
                      id={`src-${r.n}`}
                      className="source-row"
                      style={{ display: 'flex', gap: '0.6rem', padding: '0.3rem 0.4rem', scrollMarginTop: 80 }}
                    >
                      <span
                        className="mono"
                        style={{
                          minWidth: '1.6em',
                          textAlign: 'right',
                          color: r.cited ? 'var(--accent)' : 'var(--fg-dim)',
                        }}
                      >
                        {r.n}
                      </span>
                      <span>
                        {r.title ? (
                          <Link href={`/source/${r.source_id}`}>{r.title}</Link>
                        ) : (
                          <span style={{ color: 'var(--fg-dim)' }}>Source no longer in the wiki</span>
                        )}
                        {safeExternalUrl(r.source_url) && (
                          <>
                            {' '}
                            &mdash;{' '}
                            <a href={safeExternalUrl(r.source_url)!} target="_blank" rel="noopener noreferrer">
                              original
                            </a>
                          </>
                        )}
                        {r.date && (
                          <span className="meta" style={{ marginLeft: '0.5rem' }}>
                            <LocalDate iso={r.date} />
                          </span>
                        )}
                      </span>
                    </li>
                  ))}
                </ol>
              </>
            )}
            {page.previous_content_path && (
              <details style={{ marginTop: '1rem' }}>
                <summary
                  style={{ cursor: 'pointer', color: 'var(--fg-dim)', userSelect: 'none' }}
                >
                  View previous version
                </summary>
                <PreviousVersionPanel
                  pageId={page_id}
                  pageType={page.page_type}
                  lastUpdated={page.last_updated}
                  restorable={page_id !== 'saved-links'}
                  restoreDisabledReason={
                    getRunningCompileSession() ? 'A compile is running. Restore when it has finished.' : null
                  }
                />
              </details>
            )}
          </footer>
        )}
      </main>

      {/* Right: TOC + Backlinks */}
      <aside
        style={{
          width: 293,
          flexShrink: 0,
          padding: '2rem 1rem',
          borderLeft: '1px solid var(--border)',
          fontSize: 13,
          position: 'sticky',
          // Below the fixed 65px TopNav (same zoomed coordinate space).
          top: 65,
          maxHeight: 'calc(100dvh / 0.9 - 65px)',
          overflowY: 'auto',
          alignSelf: 'flex-start',
        }}
      >
        <WikiToc headings={headings} />

        <section>
          <h2 className="meta" style={{ marginBottom: '0.5rem' }}>
            Linked from ({backlinks.length})
          </h2>
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

        {page.page_type === 'source-summary' && sourceList[0] && (
          <section style={{ marginTop: '2rem' }}>
            <Link
              href={`/source/${sourceList[0].source_id}`}
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

        {page_id !== SAVED_LINKS_PAGE_ID && (
          <>
            <ContradictingSourcesPanel pageId={page_id} />
            <RelatedPagesPanel pageId={page_id} />
          </>
        )}
      </aside>
    </div>
  );
}
