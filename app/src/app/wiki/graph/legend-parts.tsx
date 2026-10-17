'use client';

/**
 * Small pieces of the graph legend: the collapsed "Filters" button, the
 * icon buttons' style, a filter row (a real, visible checkbox that shows on
 * or off, a swatch, a noun label and a count; the whole row is clickable),
 * the checkbox glyph itself, and the dot swatch. Filter rows look like
 * controls (pointer, hover tint, focus ring: globals.css
 * .graph-legend-filter); the key's rows (LegendKey.tsx) use none of this.
 */

import type { CSSProperties, ReactNode, Ref } from 'react';
import { SlidersHorizontal } from 'lucide-react';
import { filtersBadge } from '../../../lib/graph-legend';
import { FILTERS_BUTTON_HEIGHT, LEGEND_LEFT, LEGEND_TOP } from '../../../lib/graph-panels';

export const LEGEND_HEADING: CSSProperties = {
  margin: '0 0 4px', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 10, lineHeight: '14px',
  letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--fg-dim)',
};
const HIDDEN_INPUT: CSSProperties = { position: 'absolute', opacity: 0, width: 1, height: 1, margin: 0, pointerEvents: 'none' };
const ROW: CSSProperties = {
  position: 'relative', display: 'flex', alignItems: 'center', gap: 8, minHeight: 26, padding: '0 6px', margin: '0 -6px',
  borderRadius: 4, cursor: 'pointer', userSelect: 'none', fontFamily: 'var(--font-body)', fontSize: 12, lineHeight: '16px',
};

/** A filter: checked = shown. The label names the thing ("Source pages"), never an action. */
export function FilterRow(props: {
  on: boolean; label: string; count?: number; swatch: ReactNode; swatchWidth?: number; onToggle(): void;
}) {
  const { on, label, count, swatch, swatchWidth = 14, onToggle } = props;
  return (
    <label className="graph-legend-row graph-legend-filter" data-filter={label} style={{ ...ROW, color: on ? 'var(--fg-secondary)' : 'var(--fg-dim)' }}>
      <input type="checkbox" checked={on} onChange={onToggle} style={HIDDEN_INPUT} />
      <CheckGlyph on={on} />
      <span style={{ width: swatchWidth, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>{swatch}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{label}</span>
      {count !== undefined && <span style={{ color: 'var(--fg-dim)', fontVariantNumeric: 'tabular-nums' }}>{count}</span>}
    </label>
  );
}

/** A small square icon button on the legend (ⓘ, ×): hover tint and focus ring in globals.css .graph-icon-btn. */
export const ICON_BUTTON: CSSProperties = {
  width: 26, height: 26, flexShrink: 0, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
  padding: 0, border: '1px solid transparent', cursor: 'pointer',
};

/**
 * The collapsed legend, a map-app style control: a small floating "Filters"
 * button with a badge when any filter differs from the default map
 * ("3 changed": the state, not an action). Styled like the graph header's
 * buttons (border, hover, focus ring: globals.css .graph-filters-btn).
 */
export function FiltersButton(props: {
  open: boolean; controls: string; changed: number; onExpand(): void; buttonRef: Ref<HTMLButtonElement>;
}) {
  const { open, controls, changed, onExpand, buttonRef } = props;
  const badge = filtersBadge(changed);
  return (
    <button
      ref={buttonRef}
      type="button"
      className="graph-filters-btn"
      hidden={open}
      aria-expanded={open}
      aria-controls={controls}
      title={badge ? `Expand filters (${changed} changed from the default map)` : 'Expand filters'}
      onClick={onExpand}
      style={{
        position: 'absolute', left: LEGEND_LEFT, top: LEGEND_TOP, zIndex: 10, height: FILTERS_BUTTON_HEIGHT,
        display: open ? 'none' : 'inline-flex', alignItems: 'center', gap: 8, padding: '0 12px', cursor: 'pointer',
        backdropFilter: 'blur(6px)', whiteSpace: 'nowrap',
        fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 10, lineHeight: '15px', letterSpacing: 1, textTransform: 'uppercase',
      }}
    >
      <SlidersHorizontal size={14} aria-hidden />
      Filters
      {badge && (
        <span
          data-badge
          style={{
            padding: '1px 6px', border: '1px solid rgba(var(--accent-rgb),0.35)', background: 'rgba(var(--accent-rgb),0.14)',
            color: 'var(--accent)', fontFamily: 'var(--font-body)', fontWeight: 600, fontSize: 11, lineHeight: '15px',
            letterSpacing: 0, textTransform: 'none',
          }}
        >
          {badge}
        </span>
      )}
    </button>
  );
}

/** A checkbox: filled with a tick when on, an empty box when off. */
function CheckGlyph({ on }: { on: boolean }) {
  return (
    <span
      aria-hidden
      style={{
        width: 14, height: 14, flexShrink: 0, borderRadius: 3, display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
        border: `1.5px solid ${on ? 'var(--accent)' : 'var(--fg-dim)'}`, background: on ? 'var(--accent)' : 'transparent',
      }}
    >
      {on && (
        <svg width={10} height={10} viewBox="0 0 10 10">
          <path d="M2 5.2 L4.2 7.4 L8 2.8" fill="none" stroke="#0D0E10" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" />
        </svg>
      )}
    </span>
  );
}

/** A dot swatch: a topic's colour, a ringed page type, a faint source page, a dashed missing page. */
export function Dot(props: { color: string; size?: number; ring?: boolean; faint?: boolean; dashed?: boolean; accentRing?: boolean }) {
  const { color, size = 9, ring = false, faint = false, dashed = false, accentRing = false } = props;
  return (
    <span
      style={{
        width: size, height: size, borderRadius: '50%', display: 'inline-block', flexShrink: 0,
        border: `1.5px ${dashed ? 'dashed' : 'solid'} ${color}`, background: dashed ? 'transparent' : color, opacity: faint ? 0.6 : 1,
        boxShadow: ring
          ? '0 0 0 2px #121316, 0 0 0 3px rgba(236,236,240,0.55)'
          : accentRing ? '0 0 0 2px #121316, 0 0 0 3.5px #98FFD9' : undefined,
      }}
    />
  );
}
