'use client';

/**
 * The graph page's header: title and counts, the focus controls when the map
 * is focused on a page (its name, a 1 / 2 hops switch, back to the full
 * map), "Connect two pages", and the Wiki / Graph switch (its Graph tab
 * leaves a focus). Inline styles and
 * CSS vars; buttons show the keyboard focus (globals.css .graph-header-btn).
 */

import type { CSSProperties, MouseEvent } from 'react';
import { Route, X } from 'lucide-react';
import WikiViewToggle from '../../../components/WikiViewToggle';
import type { FocusDepth } from '../../../lib/graph-scope';

interface Props {
  pages: number;
  lines: number;
  /** The focused page's title, or null on the full map. */
  focusTitle: string | null;
  depth: FocusDepth;
  onDepth(depth: FocusDepth): void;
  onFullMap(): void;
  pathOpen: boolean;
  onPath(): void;
  /** A one-line note, e.g. a focus link to a page that is not on the map. */
  notice: string | null;
}

const SMALL_CAPS: CSSProperties = {
  fontSize: 10, color: 'var(--fg-muted)', textTransform: 'uppercase', letterSpacing: '0.6px', fontFamily: 'var(--font-body)',
};
const DIVIDER = <span style={{ width: 1, height: 16, background: 'rgba(71,72,74,0.3)', display: 'inline-block', flexShrink: 0 }} />;

/** A small header button; `on` marks the chosen depth. */
function chip(on = false): CSSProperties {
  return {
    height: 26, padding: '0 10px', display: 'inline-flex', alignItems: 'center', gap: 6, cursor: 'pointer',
    border: `1px solid ${on ? 'rgba(var(--accent-rgb),0.45)' : 'rgba(71,72,74,0.4)'}`,
    background: on ? 'rgba(var(--accent-rgb),0.12)' : 'rgba(36,38,41,0.7)',
    color: on ? 'var(--accent)' : 'var(--fg-secondary)',
    fontFamily: 'var(--font-body)', fontSize: 12, lineHeight: '16px', whiteSpace: 'nowrap',
  };
}

/** A click on the current view's tab while focused: back to the full map instead of a same-page navigation. */
function leaveFocusOnGraphTab(e: MouseEvent<HTMLDivElement>, focused: boolean, onFullMap: () => void): void {
  if (!focused || !(e.target instanceof Element) || !e.target.closest('a[aria-current="page"]')) return;
  e.preventDefault();
  onFullMap();
}

export default function GraphHeader({ pages, lines, focusTitle, depth, onDepth, onFullMap, pathOpen, onPath, notice }: Props) {
  return (
    <header
      style={{
        display: 'flex', alignItems: 'center', gap: '1rem', padding: '0.75rem 1.5rem', zIndex: 30, minWidth: 0,
        borderBottom: '1px solid rgba(71,72,74,0.15)', background: 'rgba(36,38,41,0.6)', backdropFilter: 'blur(12px)',
      }}
    >
      <h1 style={{ margin: 0, fontSize: '0.875rem', fontWeight: 700, fontFamily: 'var(--font-heading)', color: 'var(--fg)', letterSpacing: '-0.35px', whiteSpace: 'nowrap' }}>
        Knowledge Graph
      </h1>
      {DIVIDER}
      <span aria-live="polite" style={{ ...SMALL_CAPS, whiteSpace: 'nowrap' }}>
        {pages} page{pages === 1 ? '' : 's'} · {lines} connection{lines === 1 ? '' : 's'}
      </span>
      {focusTitle !== null && (
        <>
          {DIVIDER}
          <div role="group" aria-label="Focus" style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0 }}>
            <span style={SMALL_CAPS}>Focus</span>
            <span
              title={focusTitle}
              style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--fg)', fontWeight: 600, maxWidth: 260, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}
            >
              {focusTitle}
            </span>
            <div style={{ display: 'flex' }}>
              {([1, 2] as const).map((d) => (
                <button
                  key={d}
                  type="button"
                  className="graph-header-btn"
                  aria-pressed={depth === d}
                  onClick={() => onDepth(d)}
                  title={d === 1 ? 'Pages one line away' : 'Pages up to two lines away'}
                  style={{ ...chip(depth === d), marginLeft: d === 2 ? -1 : 0 }}
                >
                  {d === 1 ? '1 hop' : '2 hops'}
                </button>
              ))}
            </div>
            <button type="button" className="graph-header-btn" onClick={onFullMap} title="Back to the full map" style={chip()}>
              <X size={12} aria-hidden />
              Full map
            </button>
          </div>
        </>
      )}
      {notice && <span role="status" style={{ ...SMALL_CAPS, textTransform: 'none', letterSpacing: 0, fontSize: 12 }}>{notice}</span>}
      <div style={{ marginLeft: 'auto', display: 'flex', alignItems: 'center', gap: 12 }}>
        <button
          type="button"
          className="graph-header-btn"
          aria-pressed={pathOpen}
          onClick={onPath}
          title="Find how two pages connect"
          style={{
            ...chip(pathOpen), height: 35, padding: '0 14px', gap: 8, border: '1px solid rgba(var(--accent-rgb),0.2)',
            background: pathOpen ? 'rgba(var(--accent-rgb),0.12)' : 'var(--bg-card-hover)', color: pathOpen ? 'var(--accent)' : 'var(--fg-secondary)',
            fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 10, lineHeight: '15px', letterSpacing: 1, textTransform: 'uppercase',
          }}
        >
          <Route size={12} aria-hidden />
          Connect two pages
        </button>
        {/* The active Graph tab while focused leaves the focus in place (no navigation, no history entry). */}
        <div onClickCapture={(e) => leaveFocusOnGraphTab(e, focusTitle !== null, onFullMap)}>
          <WikiViewToggle active="graph" />
        </div>
      </div>
    </header>
  );
}
