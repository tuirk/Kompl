/**
 * Compiled wiki page view — SERVER component.
 *
 * Reads the page row from SQLite via the single-writer db.ts wrapper,
 * reads the gzipped compiled markdown from /data/pages/<page_id>.md.gz,
 * and renders it as HTML via the `marked` wrapper in lib/markdown.ts.
 *
 * Also shows the entity list extracted by the LLM and a link back to the
 * originating source row.
 *
 * Server components in Next.js receive `params` as a Promise that must be
 * awaited. Do NOT add "use client" — reads directly from SQLite.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getDb, getPage, readPageMarkdown, type PageRow } from '../../../lib/db';
import { renderMarkdown } from '../../../lib/markdown';

interface PageProps {
  params: Promise<{ page_id: string }>;
}

const PAGE_TYPE_LABELS: Record<string, string> = {
  'source-summary': 'source summary',
  concept: 'concept',
  entity: 'entity',
  topic: 'topic',
};

function formatDate(iso: string): string {
  const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export default async function WikiPage({ params }: PageProps) {
  const { page_id } = await params;
  const page: PageRow | null = getPage(page_id);
  if (!page) notFound();

  const markdown = readPageMarkdown(page_id);
  const html = markdown ? renderMarkdown(markdown) : null;

  // Look up the originating source (via provenance table).
  const db = getDb();
  const provRow = db
    .prepare(
      `SELECT p.source_id, s.title as source_title, s.source_url
         FROM provenance p
         JOIN sources s ON s.source_id = p.source_id
         WHERE p.page_id = ?
         ORDER BY p.date_compiled DESC
         LIMIT 1`
    )
    .get(page_id) as
    | { source_id: string; source_title: string; source_url: string | null }
    | undefined;

  return (
    <main
      style={{
        maxWidth: 820,
        margin: '0 auto',
        padding: '3rem 1.5rem 5rem',
      }}
    >
      <div style={{ marginBottom: '1.5rem' }}>
        <Link href="/feed">← Back to feed</Link>
      </div>

      <header
        style={{
          borderBottom: '1px solid var(--border)',
          paddingBottom: '1rem',
          marginBottom: '1.75rem',
        }}
      >
        <h1 style={{ margin: '0 0 0.5rem', fontSize: '2rem', lineHeight: 1.2 }}>
          {page.title}
        </h1>
        <div
          style={{
            display: 'flex',
            gap: '0.85rem',
            color: 'var(--fg-muted)',
            fontSize: 13,
            flexWrap: 'wrap',
            alignItems: 'center',
          }}
        >
          <span
            style={{
              border: '1px solid var(--border-hover)',
              padding: '0.1em 0.55em',
              borderRadius: 999,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
              fontSize: 11,
            }}
          >
            {PAGE_TYPE_LABELS[page.page_type] ?? page.page_type}
          </span>
          {page.category && (
            <span
              style={{
                background: 'var(--bg-card)',
                border: '1px solid var(--border)',
                padding: '0.1em 0.55em',
                borderRadius: 4,
                fontSize: 12,
              }}
            >
              {page.category}
            </span>
          )}
          <span>Updated {formatDate(page.last_updated)}</span>
        </div>
        {page.summary && (
          <p
            style={{
              margin: '1rem 0 0',
              color: 'var(--fg-muted)',
              lineHeight: 1.6,
              fontSize: 15,
            }}
          >
            {page.summary}
          </p>
        )}
      </header>

      {html ? (
        <article dangerouslySetInnerHTML={{ __html: html }} />
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
          <strong>Page file missing.</strong> The page row exists in the database but the
          file at <code>{page.content_path}</code> is not readable.
        </div>
      )}

      <footer
        style={{
          marginTop: '3rem',
          paddingTop: '1.5rem',
          borderTop: '1px solid var(--border)',
          color: 'var(--fg-muted)',
          fontSize: 12,
        }}
      >
        {provRow && (
          <p style={{ margin: '0 0 0.35rem' }}>
            Compiled from{' '}
            <Link href={`/source/${provRow.source_id}`}>{provRow.source_title}</Link>
            {provRow.source_url && (
              <>
                {' '}
                (
                <a href={provRow.source_url} target="_blank" rel="noopener noreferrer">
                  original
                </a>
                )
              </>
            )}
          </p>
        )}
        <p style={{ margin: '0 0 0.35rem' }}>
          Stored as <code>{page.content_path}</code>
        </p>
        <p style={{ margin: 0 }}>
          <code>{page.source_count}</code> source{page.source_count === 1 ? '' : 's'} contributed
        </p>
      </footer>
    </main>
  );
}
