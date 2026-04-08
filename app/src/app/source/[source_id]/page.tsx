/**
 * Rendered source page — SERVER component.
 *
 * Reads the source row from SQLite via the single-writer db.ts wrapper,
 * reads the gzipped raw markdown from /data/raw/<source_id>.md.gz, and
 * renders it as HTML via the `marked` wrapper in lib/markdown.ts.
 *
 * Security note: we use dangerouslySetInnerHTML on markdown output.
 * `marked` is configured to not emit raw HTML from markdown input
 * (lib/markdown.ts, commit 3), so the most dangerous vectors are closed.
 * However, `marked` does not strip malicious URLs in links/images. For
 * commit 3 the trust model is "user chose to ingest this source, they
 * trust it." A proper sanitizer (DOMPurify or rehype-sanitize) can be
 * wired in when multi-user support lands.
 *
 * Server components in Next.js 16 receive `params` as a Promise that
 * must be awaited. Do NOT add "use client" to this file — it reads
 * directly from SQLite.
 */

import Link from 'next/link';
import { notFound } from 'next/navigation';

import { getSource, readRawMarkdown, type SourceRow } from '../../../lib/db';
import { renderMarkdown } from '../../../lib/markdown';

interface PageProps {
  params: Promise<{ source_id: string }>;
}

function parseMetadata(raw: string | null): Record<string, unknown> | null {
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch {
    return null;
  }
}

function formatDate(iso: string): string {
  const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  if (isNaN(d.getTime())) return iso;
  return d.toISOString().replace('T', ' ').slice(0, 19) + ' UTC';
}

export default async function SourcePage({ params }: PageProps) {
  const { source_id } = await params;
  const source: SourceRow | null = getSource(source_id);
  if (!source) notFound();

  const markdown = readRawMarkdown(source_id);
  const metadata = parseMetadata(source.metadata);

  const html = markdown ? renderMarkdown(markdown) : null;

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
          {source.title}
        </h1>
        <div
          style={{
            display: 'flex',
            gap: '0.85rem',
            color: 'var(--fg-muted)',
            fontSize: 13,
            flexWrap: 'wrap',
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
            {source.source_type}
          </span>
          <span>{formatDate(source.date_ingested)}</span>
          {source.source_url && (
            <a href={source.source_url} target="_blank" rel="noopener noreferrer">
              {source.source_url}
            </a>
          )}
        </div>
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
          <strong>Raw markdown file missing.</strong> The source row exists in the database but
          the file at <code>{source.file_path}</code> is not readable. This indicates DB/filesystem
          drift — the integration test&apos;s single-writer canary stage should catch this.
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
        <p style={{ margin: '0 0 0.35rem' }}>
          Stored as <code>{source.file_path}</code>
        </p>
        <p style={{ margin: '0 0 0.35rem' }}>
          SHA256 <code>{source.content_hash.slice(0, 12)}…</code>
        </p>
        {metadata && (
          <details style={{ marginTop: '0.75rem' }}>
            <summary style={{ cursor: 'pointer' }}>Source metadata</summary>
            <pre
              style={{
                background: 'var(--bg-card)',
                padding: '0.8em 1em',
                borderRadius: 6,
                fontSize: 12,
                overflowX: 'auto',
                marginTop: '0.5rem',
              }}
            >
              {JSON.stringify(metadata, null, 2)}
            </pre>
          </details>
        )}
      </footer>
    </main>
  );
}
