'use client';

/**
 * Pieces shared by the graph's side panels (NodePanel, EdgePanel,
 * PathPanel): the shell on the right (its width comes from the page through
 * PanelWidthContext; a grip in its bottom-left corner resizes it), section
 * headings, the evidence list under a connection and the small text styles.
 * Inline styles and CSS vars, as the rest of the app.
 */

import Link from 'next/link';
import { createContext, useContext, useEffect, useId, useRef, type CSSProperties, type ReactNode, type RefObject } from 'react';
import { moreSourcesNote } from '../../../lib/connections-view';
import { focusTargetOnClose, PANEL_DEFAULT_WIDTH, type GripRange } from '../../../lib/graph-panels';
import ResizeGrip from './ResizeGrip';
import { useMoreEvidence, type EvidenceItem } from './useMoreEvidence';

/** The details panel's width and its limits, and how its grip changes it (the page keeps the size). */
export const PanelWidthContext = createContext<{ width: number; range?: GripRange; onWidth?(width: number): void; onDone?(): void }>({
  width: PANEL_DEFAULT_WIDTH,
});

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
  /** False when the panel comes back because a filter showed its page again: focus stays where it is. */
  takeFocus?: boolean;
}) {
  const headingRef = useRef<HTMLHeadingElement>(null);
  const asideRef = useRef<HTMLElement>(null);
  const { returnFocusTo, takeFocus = true } = props;
  const { width, range, onWidth, onDone } = useContext(PanelWidthContext);
  const panelId = useId();
  const start = useRef(width);
  // The panel grows leftwards: a drag to the left (negative dx) widens it.
  const resize = (dx: number, _dy: number, begin: boolean) => {
    if (begin) start.current = width;
    else onWidth?.(start.current - dx);
  };
  // Opening moves focus to the heading, so keyboard users land in the panel;
  // closing (or switching to another page's panel) hands it back, unless the
  // viewer has put focus elsewhere (lib/graph-panels.ts focusTargetOnClose).
  useEffect(() => {
    const panel = asideRef.current;
    const before = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    if (takeFocus) headingRef.current?.focus({ preventScroll: true });
    return () => {
      focusTargetOnClose(document.activeElement, document.body, panel, before, returnFocusTo.current)?.focus({ preventScroll: true });
    };
    // `takeFocus` counts when the panel opens only; a later change must not move focus.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [returnFocusTo]);
  return (
    <aside
      ref={asideRef}
      id={panelId}
      aria-label="Graph details"
      style={{
        position: 'absolute', right: 0, top: 0, bottom: 0, width, zIndex: 20,
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
      {onWidth && range && (
        <ResizeGrip label="Resize panel" grip="panel" range={range} controls={panelId} valueText={`${width} px wide`}
          onResize={resize} onDone={() => onDone?.()} />
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

/**
 * The sources behind a connection (archived ones marked), each with its own
 * sentence in quotation marks when extraction checked it against the
 * source, else Kompl's one-line summary, labelled as Kompl's. The first
 * three come with the connection; "+N more sources" loads and shows the
 * rest, "Show fewer" folds them away (useMoreEvidence.ts).
 */
export function EvidenceList({ item, pageId }: { item: EvidenceItem; pageId: string }) {
  const note = moreSourcesNote(item);
  const { state, open, close } = useMoreEvidence(pageId, item);
  const evidence = state.status === 'open' ? state.evidence : item.evidence;
  return (
    <ul style={{ listStyle: 'none', margin: 0, padding: '0 0 0 10px', borderLeft: '2px solid var(--border-hover)' }}>
      {evidence.map((e) => (
        <li key={e.source_id} style={{ padding: '4px 0' }}>
          {(e.quote ?? e.sentence) && (
            <span style={{ ...BODY, display: 'block' }}>{e.quote ? `“${e.quote}”` : e.sentence}</span>
          )}
          <span style={META}>
            {e.quote ? 'Quoted from ' : e.sentence ? "Kompl's summary, from " : null}
            <Link href={`/source/${e.source_id}`} style={{ color: 'var(--accent)' }}>
              {e.source_title}
            </Link>
            {e.source_archived && <span title="This source is archived">{' (archived)'}</span>}
          </span>
        </li>
      ))}
      {note && (
        <li style={{ ...META, padding: '4px 0' }}>
          {state.status === 'loading' && 'Loading the other sources…'}
          {state.status === 'error' && 'Could not load the other sources. '}
          {state.status !== 'loading' && (
            <button type="button" className="graph-header-btn" aria-expanded={state.status === 'open'}
              onClick={state.status === 'open' ? close : open} style={{ ...LINK_BUTTON, color: 'var(--accent)' }}>
              {state.status === 'open' ? 'Show fewer' : state.status === 'error' ? 'Try again' : note}
            </button>
          )}
        </li>
      )}
    </ul>
  );
}

const FOOTER_BUTTON: CSSProperties = {
  flex: 1, padding: '12px 0', display: 'flex', justifyContent: 'center', alignItems: 'center', gap: 8,
  border: '1px solid rgba(var(--accent-rgb),0.3)', textDecoration: 'none', overflow: 'hidden',
  fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 11, letterSpacing: '1px',
  textTransform: 'uppercase', color: 'var(--accent)', whiteSpace: 'nowrap', background: 'none', cursor: 'pointer',
};

/** A full-width link in the panel footer. */
export function FooterLink({ href, children }: { href: string; children: ReactNode }) {
  return (
    <Link href={href} style={FOOTER_BUTTON}>
      {children}
    </Link>
  );
}

/** A full-width button in the panel footer, styled as FooterLink. */
export function FooterButton({ onClick, title, children }: { onClick(): void; title?: string; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={title} style={FOOTER_BUTTON}>
      {children}
    </button>
  );
}

/** The small accent tag a bridge page carries ("BRIDGE"). */
export const BADGE: CSSProperties = {
  display: 'inline-block', padding: '0 5px', border: '1px solid rgba(var(--accent-rgb),0.45)', borderRadius: 3,
  fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 9, lineHeight: '15px', letterSpacing: '1px',
  textTransform: 'uppercase', color: 'var(--accent)', verticalAlign: '1px',
};

export function PanelNote({ children }: { children: ReactNode }) {
  return <p style={{ ...META, margin: 0 }}>{children}</p>;
}
