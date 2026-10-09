import type { Metadata } from 'next';
import Link from 'next/link';

export const metadata: Metadata = { title: 'Page not found' };

/** Shown for any unknown route and whenever a page calls notFound(). */
export default function NotFound() {
  return (
    <main style={{ maxWidth: 640, margin: '0 auto', padding: '6rem 1.5rem 5rem' }}>
      <div className="meta" style={{ marginBottom: '0.75rem' }}>
        404
      </div>
      <h1 style={{ fontSize: '2rem', margin: '0 0 0.75rem' }}>This page isn&apos;t in your wiki</h1>
      <p style={{ color: 'var(--fg-muted)', lineHeight: 1.7, margin: '0 0 2rem' }}>
        It may have been merged into another page, removed along with its sources, or the
        link is mistyped. Search the wiki or browse it from the index.
      </p>
      <div style={{ display: 'flex', gap: '1.25rem', flexWrap: 'wrap' }}>
        <Link href="/wiki/search">Search the wiki →</Link>
        <Link href="/wiki">Browse all pages →</Link>
        <Link href="/">Dashboard →</Link>
      </div>
    </main>
  );
}
