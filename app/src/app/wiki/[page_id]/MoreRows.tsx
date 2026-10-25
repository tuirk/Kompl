'use client';

/**
 * The Connections card's "Show all N" disclosure (ConnectionsPanel.tsx).
 * Opened, the rows follow and "Show fewer" comes after the last of them,
 * not in the middle of the list; closing moves focus back to "Show all".
 * A native <details>, so the rows are in the page (find-in-page opens it).
 */

import { useRef, type CSSProperties, type ReactNode } from 'react';

const TOGGLE: CSSProperties = {
  display: 'block',
  width: '100%',
  padding: '4px 8px',
  borderRadius: 6,
  fontSize: 13,
  lineHeight: '20px',
  fontFamily: 'inherit',
  fontWeight: 400,
  textAlign: 'left',
  color: 'var(--accent)',
};

export default function MoreRows({ total, children }: { total: number; children: ReactNode }) {
  const details = useRef<HTMLDetailsElement>(null);
  const summary = useRef<HTMLElement>(null);
  function showFewer() {
    if (details.current) details.current.open = false;
    summary.current?.focus();
  }
  return (
    <details ref={details} className="wiki-rp-more">
      <summary ref={summary} className="wiki-rp-item" style={TOGGLE}>
        Show all {total}
      </summary>
      {children}
      <button type="button" className="wiki-rp-item" onClick={showFewer} style={{ ...TOGGLE, border: 'none' }}>
        Show fewer
      </button>
    </details>
  );
}
