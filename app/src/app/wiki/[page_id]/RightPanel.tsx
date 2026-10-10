/**
 * The wiki article's right panel, below "On this page" (components/WikiToc):
 * Disputes, Linked from, You might also read and, for source notes, the
 * original. Server components, laid out like the left sidebar: rows that tint
 * on hover and show a focus ring for the keyboard, section labels with counts.
 * Colours and hover live in globals.css (.wiki-rp-*).
 */

import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { FileText, Flag, Scale } from 'lucide-react';
import { LocalDate } from '../../../components/LocalDate';
import type { PageDispute } from '../../../lib/page-disputes';
import type { NumberedSource } from '../../../lib/page-sources';

const APP_URL = process.env.APP_URL ?? 'http://app:3000';
/** "Linked from" rows shown before "Show all". */
const LINKED_FROM_VISIBLE = 8;
/** The panel's own API reads; never hold the page longer. */
const FETCH_TIMEOUT_MS = 3_000;

const ROW: CSSProperties = {
  display: 'block',
  padding: '4px 8px',
  borderRadius: 6,
  fontSize: 14,
  lineHeight: '20px',
  textDecoration: 'none',
};
const TRUNCATE: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
const NOTE: CSSProperties = { display: 'block', fontSize: 12, lineHeight: '17px', color: 'var(--fg-dim)' };
const ICON: CSSProperties = { flexShrink: 0, marginTop: 3 };

export function PanelSection({ label, count, children }: { label: string; count?: number; children: ReactNode }) {
  return (
    <section style={{ marginTop: '1.75rem' }}>
      <h2
        className="meta"
        style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: '0 0 0.4rem', padding: '0 8px', fontWeight: 400 }}
      >
        {label}
        {count !== undefined && <span style={{ fontVariantNumeric: 'tabular-nums', opacity: 0.8 }}>{count}</span>}
      </h2>
      {children}
    </section>
  );
}

function PageRow({ href, title }: { href: string; title: string }) {
  return (
    <Link href={href} className="wiki-rp-item" title={title} style={{ ...ROW, ...TRUNCATE }}>
      {title}
    </Link>
  );
}

interface FlaggedSource {
  source_id: string | null;
  source_title: string | null;
  source_url: string | null;
  reason: string | null;
  detected_at: string | null;
}

/**
 * Disputes: the ones the page records in its own text (a "Disputed" or
 * "Contradictions" section citing two or more sources, lib/page-disputes.ts),
 * then new sources the compile flagged as contradicting the page
 * (page_contradiction_detected, via /api/wiki/[page_id]/contradictions).
 */
export async function DisputesPanel({
  pageId,
  disputes,
  sources,
}: {
  pageId: string;
  disputes: ReadonlyArray<PageDispute>;
  sources: ReadonlyArray<NumberedSource>;
}) {
  const res = await fetch(`${APP_URL}/api/wiki/${pageId}/contradictions`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).catch(() => null);
  const flagged: FlaggedSource[] = res?.ok ? ((await res.json()) as { items: FlaggedSource[] }).items : [];

  const total = disputes.length + flagged.length;
  if (total === 0) return null;
  const byId = new Map(sources.map((s) => [s.source_id, s]));

  return (
    <PanelSection label="Disputes" count={total}>
      {disputes.map((d) => {
        const sides = d.sourceIds.map((id) => byId.get(id));
        const names = sides.map((s) => (s ? `${s.n}. ${s.title ?? 'Untitled source'}` : 'A source no longer in the wiki'));
        return (
          <a
            key={`${d.anchor}-${d.headingIndex}`}
            href={`#${d.anchor}`}
            className="wiki-rp-item"
            title={`Sources that disagree:\n${names.join('\n')}`}
            style={{ ...ROW, display: 'flex', gap: 8, alignItems: 'flex-start' }}
          >
            <Scale size={14} aria-hidden style={{ ...ICON, color: 'var(--warning)' }} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block' }}>{d.topic}</span>
              <span style={NOTE}>{`${d.sourceIds.length} sources disagree`}</span>
            </span>
          </a>
        );
      })}
      {flagged.map((item, idx) => {
        const label = item.source_title ?? item.source_url ?? 'Untitled source';
        const body = (
          <>
            <Flag size={14} aria-hidden style={{ ...ICON, color: 'var(--danger)' }} />
            <span style={{ minWidth: 0 }}>
              <span style={{ display: 'block' }}>{label}</span>
              <span style={NOTE}>
                {item.reason ?? 'Contradicts this page.'}
                {item.detected_at && (
                  <>
                    {' · flagged '}
                    <LocalDate iso={item.detected_at} />
                  </>
                )}
              </span>
            </span>
          </>
        );
        const key = `${item.source_id ?? 'unknown'}-${item.detected_at ?? idx}`;
        const style: CSSProperties = { ...ROW, display: 'flex', gap: 8, alignItems: 'flex-start' };
        return item.source_id ? (
          <Link key={key} href={`/source/${item.source_id}`} className="wiki-rp-item" style={style}>
            {body}
          </Link>
        ) : (
          <div key={key} style={{ ...style, color: 'var(--fg-muted)' }}>
            {body}
          </div>
        );
      })}
    </PanelSection>
  );
}

/** Pages that link here: the first few, the rest behind "Show all". */
export function LinkedFrom({ pages }: { pages: ReadonlyArray<{ page_id: string; title: string }> }) {
  const visible = pages.slice(0, LINKED_FROM_VISIBLE);
  const rest = pages.slice(LINKED_FROM_VISIBLE);
  return (
    <PanelSection label="Linked from" count={pages.length}>
      {pages.length === 0 ? (
        <p style={{ ...NOTE, margin: 0, padding: '0 8px' }}>No pages link here yet.</p>
      ) : (
        <>
          {visible.map((p) => (
            <PageRow key={p.page_id} href={`/wiki/${p.page_id}`} title={p.title} />
          ))}
          {rest.length > 0 && (
            <details className="wiki-rp-more">
              <summary className="wiki-rp-item" style={{ ...ROW, fontSize: 13, color: 'var(--accent)' }}>
                <span className="wiki-rp-all">Show all {pages.length}</span>
                <span className="wiki-rp-less">Show fewer</span>
              </summary>
              {rest.map((p) => (
                <PageRow key={p.page_id} href={`/wiki/${p.page_id}`} title={p.title} />
              ))}
            </details>
          )}
        </>
      )}
    </PanelSection>
  );
}

/**
 * "You might also read": embedding similarity, zero LLM cost
 * (/api/wiki/[page_id]/related). Gives up after 3 seconds so a slow NLP
 * service never holds up the page (the route logs it); hidden when empty.
 */
export async function RelatedPages({ pageId }: { pageId: string }) {
  const res = await fetch(`${APP_URL}/api/wiki/${pageId}/related`, {
    cache: 'no-store',
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  }).catch(() => null);
  if (!res || !res.ok) return null;

  const data = (await res.json()) as {
    items: Array<{ page_id: string; title: string; page_type: string }>;
    count: number;
    enabled: boolean;
  };
  if (!data.enabled || data.count === 0) return null;

  return (
    <PanelSection label="You might also read">
      {data.items.map((p) => (
        <PageRow key={p.page_id} href={`/wiki/${p.page_id}`} title={p.title} />
      ))}
    </PanelSection>
  );
}

/** A source note's original source. */
export function ViewOriginal({ sourceId }: { sourceId: string }) {
  return (
    <section style={{ marginTop: '1.75rem' }}>
      <Link
        href={`/source/${sourceId}`}
        className="wiki-rp-item"
        style={{ ...ROW, display: 'flex', alignItems: 'center', gap: 8, color: 'var(--accent)', fontWeight: 500 }}
      >
        <FileText size={15} aria-hidden style={{ flexShrink: 0 }} />
        View original source
      </Link>
    </section>
  );
}
