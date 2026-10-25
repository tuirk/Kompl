/**
 * The wiki article's right panel, below "On this page" (components/WikiToc):
 * Disagreements, Connections (./ConnectionsPanel.tsx, built from the pieces
 * exported here), You might also read and, for source notes, the original.
 * Server components, laid out like the left sidebar: rows that tint on hover
 * and show a focus ring for the keyboard, section labels with counts.
 * Colours and hover live in globals.css (.wiki-rp-*).
 */

import Link from 'next/link';
import type { CSSProperties, ReactNode } from 'react';
import { FileText, Flag, History, Scale } from 'lucide-react';
import { LocalDate } from '../../../components/LocalDate';
import type { PanelDisagreement } from '../../../lib/disagreement-view';
import type { NumberedSource } from '../../../lib/page-sources';
import DisagreementVerdict from './DisagreementVerdict';

const APP_URL = process.env.APP_URL ?? 'http://app:3000';
/** The panel's own API reads; never hold the page longer. */
const FETCH_TIMEOUT_MS = 3_000;

export const ROW: CSSProperties = {
  display: 'block',
  padding: '4px 8px',
  borderRadius: 6,
  fontSize: 14,
  lineHeight: '20px',
  textDecoration: 'none',
};
export const TRUNCATE: CSSProperties = { overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' };
export const NOTE: CSSProperties = { display: 'block', fontSize: 12, lineHeight: '17px', color: 'var(--fg-dim)' };
const ICON: CSSProperties = { flexShrink: 0, marginTop: 3 };

/** A section with its label and count; `action` (e.g. a link) sits at the right end of the label's row, outside the heading. */
export function PanelSection(
  { label, count, action, children }: { label: string; count?: number; action?: ReactNode; children: ReactNode }
) {
  const heading = (
    <h2
      className="meta"
      style={{ display: 'flex', alignItems: 'baseline', gap: 8, margin: action ? 0 : '0 0 0.4rem', padding: '0 8px', fontWeight: 400 }}
    >
      {label}
      {count !== undefined && <span style={{ fontVariantNumeric: 'tabular-nums' }}>{count}</span>}
    </h2>
  );
  return (
    <section style={{ marginTop: '1.75rem' }}>
      {action ? (
        <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 8, marginBottom: '0.4rem' }}>
          {heading}
          {action}
        </div>
      ) : (
        heading
      )}
      {children}
    </section>
  );
}

export function PageRow({ href, title }: { href: string; title: string }) {
  return (
    <Link href={href} className="wiki-rp-item" title={title} style={{ ...ROW, ...TRUNCATE }}>
      {title}
    </Link>
  );
}

const KIND_LABEL: Record<string, string> = {
  disputed: 'Sources disagree',
  changed: 'Changed over time',
  contradiction: 'A new source contradicts this page',
  scope: 'Different scope',
  opinion: 'Different opinions',
};

const FOUND_BY: Record<string, string> = {
  page_text: 'in the page text',
  triage: 'flagged when the source was added',
  claim_check: 'found by the claim check',
  wiki_check: 'found by the wiki check',
};

/**
 * Disagreements: the Disputed/Changed sections the page records in its own
 * text (lib/page-disputes.ts), then what Kompl's checks found against the
 * page, e.g. a new source the compile flagged as contradicting it. All come
 * from the disagreements record (lib/disagreements.ts), so each carries the
 * owner's Confirm / Dismiss (./DisagreementVerdict.tsx). Dismissed ones stay
 * listed, dimmed, so the verdict can be taken back.
 */
export function DisagreementsPanel({
  rows,
  sources,
}: {
  rows: ReadonlyArray<PanelDisagreement>;
  sources: ReadonlyArray<NumberedSource>;
}) {
  if (rows.length === 0) return null;
  const byId = new Map(sources.map((s) => [s.source_id.toLowerCase(), s]));
  const nameOf = (id: string) => {
    const s = byId.get(id.toLowerCase());
    return s ? `${s.n}. ${s.title ?? 'Untitled source'}` : 'A source no longer in the wiki';
  };
  const open = rows.filter((r) => r.status !== 'dismissed').length;

  return (
    <PanelSection label="Disagreements" count={open}>
      {rows.map((r) => {
        const dismissed = r.status === 'dismissed';
        const Icon = r.found_by !== 'page_text' ? Flag : r.kind === 'changed' ? History : Scale;
        const tone = r.found_by !== 'page_text' ? 'var(--danger)' : 'var(--warning)';
        const fromText = r.found_by === 'page_text';
        const source = r.source_id ? byId.get(r.source_id.toLowerCase()) : undefined;
        const title = fromText
          ? r.topic
          : r.topic || (source ? source.title ?? 'Untitled source' : r.source_id ? 'A source no longer in the wiki' : 'This page');
        const href = fromText ? (r.anchor ? `#${r.anchor}` : null) : r.source_id && source ? `/source/${r.source_id}` : null;
        const note = fromText
          ? r.kind === 'changed'
            ? `Changed over time · ${r.source_ids.length} sources`
            : `${r.source_ids.length} sources disagree`
          : r.reason ?? KIND_LABEL[r.kind] ?? 'Contradicts this page.';
        return (
          <div
            key={r.key}
            className="wiki-rp-item"
            title={fromText ? `Sources that disagree:\n${r.source_ids.map(nameOf).join('\n')}` : FOUND_BY[r.found_by]}
            style={{ ...ROW, display: 'flex', gap: 8, alignItems: 'flex-start', opacity: dismissed ? 0.55 : 1 }}
          >
            <Icon size={14} aria-hidden style={{ ...ICON, color: tone }} />
            <span style={{ minWidth: 0, flex: 1 }}>
              {href ? (
                <Link href={href} style={{ display: 'block', color: 'inherit', textDecoration: 'none' }}>
                  {title}
                </Link>
              ) : (
                <span style={{ display: 'block' }}>{title}</span>
              )}
              <span style={NOTE}>
                {note}
                {!fromText && r.found_at && (
                  <>
                    {' · flagged '}
                    <LocalDate iso={r.found_at} />
                  </>
                )}
              </span>
              {r.disagreement_id && <DisagreementVerdict id={r.disagreement_id} status={r.status} topic={title} />}
            </span>
          </div>
        );
      })}
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
