'use client';

/**
 * Pieces shared by the graph's side panels (NodePanel, EdgePanel): the
 * slide-in shell, section headings, the evidence list under a connection and
 * the small text styles. Inline styles and CSS vars, as the rest of the app.
 */

import Link from 'next/link';
import { useEffect, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { moreSourcesNote } from '../../../lib/connections-view';
import type { ConnectionItem } from '../../../lib/relations';

export const PANEL_WIDTH = 360;

export const KICKER: CSSProperties = {
  fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 10, lineHeight: '14px',
  letterSpacing: '1.2px', textTransform: 'uppercase', color: 'var(--fg-dim)',
};
export const META: CSSProperties = { fontFamily: 'var(--font-body)', fontSize: 12, lineHeight: '17px', color: 'var(--fg-dim)' };
export const BODY: CSSProperties = {
  fontFamily: 'var(--font-body)', fontSize: 13, lineHeight: '20px', color: 'var(--fg-secondary)',
};
export const LINK_BUTTON: CSSProperties = {
  background: 'none', border: 'none', padding: 0, margin: 0, cursor: 'pointer', textAlign: 'left',
  font: 'inherit', color: 'var(--fg)',
};
export const DOT = (color: string, size = 8): CSSProperties => ({
  width: size, height: size, borderRadius: '50%', background: color, display: 'inline-block', flexShrink: 0,
});

/** The panel on the right of the canvas: header, scrolling body, footer. */
export function PanelShell(props: {
  kicker: ReactNode;
  title: ReactNode;
  onClose(): void;
  children: ReactNode;
  footer?: ReactNode;
  /** Where focus goes on close when the element focused before the panel opened is gone. */
  returnFocusTo: RefObject<HTMLElement | null>;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const { returnFocusTo } = props;
  // Opening moves focus to the heading, so keyboard users land in the panel;
  // closing (or switching to another page's panel) hands it back.
  useEffect(() => {
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    headingRef.current?.focus({ preventScroll: true });
    return () => {
      const back = before && before !== document.body && before.isConnected ? before : returnFocusTo.current;
      back?.focus({ preventScroll: true });
    };
  }, [returnFocusTo]);
  return (
    <aside
      aria-label="Graph details"
      style={{
        position: 'absolute', right: 0, top: 0, bottom: 0, width: PANEL_WIDTH, zIndex: 20,
        display: 'flex', flexDirection: 'column', overflow: 'hidden',
        background: 'rgba(24,26,28,0.97)', borderLeft: '1px solid rgba(71,72,74,0.25)',
        boxShadow: '-20px 0 40px rgba(0,0,0,0.45)',
      }}
    >
      <div style={{ padding: '20px 20px 12px', display: 'flex', gap: 12, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 6 }}>
          <div style={KICKER}>{props.kicker}</div>
          <h2
            ref={headingRef}
            tabIndex={-1}
            style={{
              outline: 'none', margin: 0, fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 20, lineHeight: '26px',
              letterSpacing: '-0.4px', color: 'var(--fg)', overflowWrap: 'anywhere',
            }}
          >
            {props.title}
          </h2>
        </div>
        <button
          type="button"
          onClick={props.onClose}
          aria-label="Close details panel"
          title="Close (Esc)"
          style={{
            width: 32, height: 32, flexShrink: 0, background: 'none', border: 'none', cursor: 'pointer',
            color: 'var(--fg-muted)', fontSize: 16, lineHeight: 1,
          }}
        >
          ✕
        </button>
      </div>
      <div style={{ flex: 1, overflowY: 'auto', padding: '0 20px 16px', display: 'flex', flexDirection: 'column', gap: 16 }}>
        {props.children}
      </div>
      {props.footer && (
        <div style={{ padding: '12px 20px 20px', borderTop: '1px solid rgba(71,72,74,0.2)', display: 'flex', gap: 8 }}>
          {props.footer}
        </div>
      )}
    </aside>
  );
}

/** A labelled block inside a panel. */
export function PanelSection({ label, count, children }: { label: string; count?: number; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
      <h3 style={{ ...KICKER, margin: 0, color: 'var(--fg-muted)' }}>
        {label}
        {count !== undefined && <span style={{ color: 'var(--fg-dim)', marginLeft: 6 }}>{count}</span>}
      </h3>
      {children}
    </section>
  );
}

/** The sentences behind a connection, each with the source it came from (archived ones marked). */
export function EvidenceList({ item }: { item: Pick<ConnectionItem, 'evidence' | 'source_count'> }) {
  const more = moreSourcesNote(item);
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: '0 0 0 10px', borderLeft: '2px solid var(--border-hover)' }}>
      {item.evidence.map((e) => (
        <li key={e.source_id} style={{ padding: '4px 0' }}>
          {e.sentence && <span style={{ ...BODY, display: 'block' }}>{e.sentence}</span>}
          <span style={META}>
            <Link href={`/source/${e.source_id}`} style={{ color: 'var(--accent)' }}>
              {e.source_title}
            </Link>
            {e.source_archived && <span title="This source is archived">{' (archived)'}</span>}
          </span>
        </li>
      ))}
      {more && <li style={{ ...META, padding: '4px 0' }}>{more}</li>}
    </ul>
  );
}

/** A full-width button in the panel footer. */
export function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link
      href={href}
      style={{
        flex: 1, padding: '12px 0', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8,
        border: '1px solid rgba(var(--accent-rgb),0.3)', textDecoration: 'none', overflow: 'hidden',
        fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 11, letterSpacing: '1px',
        textTransform: 'uppercase', color: 'var(--accent)', whiteSpace: 'nowrap',
      }}
    >
      {children}
    </Link>
  );
}

export function PanelNote({ children }: { children: ReactNode }) {
  return <p style={{ ...META, margin: 0 }}>{children}</p>;
}
