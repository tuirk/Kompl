'use client';

/**
 * The graph's legend and filters, floating over the top left of the canvas:
 * topics (categories, with page counts; click to hide or show one), the line
 * colours and the line toggles ("related to", plain links), page types, and
 * the source-page and archived toggles. Folds away to its title.
 */

import { useMemo, type CSSProperties, type ReactNode } from 'react';
import { RING_PAGE_TYPES, type GraphFilters, type GraphModel, type VisibleGraph } from '../../../lib/graph-model';
import { NEUTRAL_HEX, PLAIN_LINK_HEX, RELATION_HEX, relationHex } from '../../../lib/graph-palette';
import { UNCATEGORIZED } from '../../../lib/graph-layout';
import { relationLabel } from '../../../lib/relation-labels';
import { PAGE_TYPE_LABELS, type PageType } from '../../../lib/page-type-palette';

/** The legend's offset and width; the page uses them to keep the map clear of it. */
export const LEGEND_LEFT = 16;
export const LEGEND_WIDTH = 236;

interface Props {
  model: GraphModel;
  visible: VisibleGraph;
  filters: GraphFilters;
  onFilters(next: GraphFilters): void;
  includeArchived: boolean;
  onIncludeArchived(next: boolean): void;
  /** Unfolded; the page keeps this, so the map's fit leaves room for it. */
  open: boolean;
  onOpen(next: boolean): void;
}

const HEADING: CSSProperties = {
  margin: '0 0 4px', fontFamily: 'var(--font-body)', fontWeight: 700, fontSize: 10, lineHeight: '14px',
  letterSpacing: '1px', textTransform: 'uppercase', color: 'var(--fg-dim)',
};
const HIDDEN_INPUT: CSSProperties = { position: 'absolute', opacity: 0, width: 1, height: 1, margin: 0, pointerEvents: 'none' };
/** Page types offered as filters, in this order; source pages have their own toggle. */
const TYPE_ORDER = ['entity', 'concept', 'overview', 'comparison'];

function toggled<T>(set: ReadonlySet<T>, values: readonly T[]): Set<T> {
  const next = new Set(set);
  const allHidden = values.every((v) => next.has(v));
  for (const v of values) {
    if (allHidden) next.delete(v);
    else next.add(v);
  }
  return next;
}

function typeLabel(type: string): string {
  const label = type in PAGE_TYPE_LABELS ? PAGE_TYPE_LABELS[type as PageType] : type.replace(/-/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export default function GraphLegend({ model, visible, filters, onFilters, includeArchived, onIncludeArchived, open, onOpen }: Props) {
  const named = model.categories.filter((c) => !c.overflow && c.name !== UNCATEGORIZED);
  const overflow = model.categories.filter((c) => c.overflow).map((c) => c.name);
  const count = (name: string) => visible.categoryCounts.get(name) ?? 0;
  // Lists that depend on the data only, worked out once per load.
  const { relationTypes, types } = useMemo(() => {
    const present = new Set(model.nodes.filter((n) => !n.isSource).map((n) => n.pageType));
    return {
      relationTypes: [...new Set(model.links.map((l) => l.colorType))].filter((t): t is string => t !== null && t !== 'related_to'),
      types: [...TYPE_ORDER.filter((t) => present.has(t)), ...[...present].filter((t) => !TYPE_ORDER.includes(t)).sort()],
    };
  }, [model]);
  const sourceCount = useMemo(
    () => model.nodes.filter((n) => n.isSource && !filters.hiddenCategories.has(n.category)).length,
    [model, filters.hiddenCategories]
  );

  const categoryRow = (key: string, label: string, color: string, names: string[]) => {
    const hidden = names.every((n) => filters.hiddenCategories.has(n));
    const n = names.reduce((s, name) => s + count(name), 0);
    if (n === 0 && !hidden) return null;
    return (
      <Row key={key} on={!hidden} label={label} count={n} swatch={<Dot color={color} on={!hidden} />}
        onToggle={() => onFilters({ ...filters, hiddenCategories: toggled(filters.hiddenCategories, names) })} />
    );
  };

  return (
    <div
      style={{
        position: 'absolute', left: LEGEND_LEFT, top: 16, zIndex: 10, width: LEGEND_WIDTH, maxHeight: 'calc(100% - 32px)',
        overflowY: 'auto', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 14,
        background: 'rgba(18,19,22,0.88)', border: '1px solid rgba(71,72,74,0.25)', backdropFilter: 'blur(6px)',
      }}
    >
      <button
        type="button"
        onClick={() => onOpen(!open)}
        aria-expanded={open}
        style={{ ...HEADING, margin: 0, display: 'flex', justifyContent: 'space-between', background: 'none', border: 'none', padding: 0, cursor: 'pointer', color: 'var(--fg-muted)' }}
      >
        <span>Legend & filters</span>
        <span aria-hidden>{open ? '−' : '+'}</span>
      </button>
      {open && (
        <>
          <Section title="Topics">
            {named.map((c) => categoryRow(c.name, c.name, c.color, [c.name]))}
            {overflow.length > 0 && categoryRow('other', `Other (${overflow.length} topics)`, NEUTRAL_HEX, overflow)}
            {model.categories.some((c) => c.name === UNCATEGORIZED) && categoryRow(UNCATEGORIZED, UNCATEGORIZED, NEUTRAL_HEX, [UNCATEGORIZED])}
          </Section>
          <Section title="Lines">
            {relationTypes.map((t) => (
              <KeyRow key={t} color={relationHex(t)} label={labelPair(t)} />
            ))}
            <Row on={filters.showRelated} label="Show “related to”" swatch={<Bar color={RELATION_HEX.related_to} on={filters.showRelated} />}
              onToggle={() => onFilters({ ...filters, showRelated: !filters.showRelated })} />
            <Row on={filters.showPlain} label="Show plain links" swatch={<Bar color={PLAIN_LINK_HEX} on={filters.showPlain} thin />}
              onToggle={() => onFilters({ ...filters, showPlain: !filters.showPlain })} />
            <p style={{ margin: 0, fontSize: 11, lineHeight: '15px', color: 'var(--fg-dim)' }}>Wider lines have more sources. Click a line to see why.</p>
          </Section>
          <Section title="Pages">
            {types.map((t) => {
              const on = !filters.hiddenTypes.has(t);
              return (
                <Row key={t} on={on} label={typeLabel(t)} count={visible.typeCounts.get(t) ?? 0}
                  swatch={<Dot color="var(--fg-muted)" on={on} ring={RING_PAGE_TYPES.has(t)} />}
                  onToggle={() => onFilters({ ...filters, hiddenTypes: toggled(filters.hiddenTypes, [t]) })} />
              );
            })}
            <Row on={filters.showSources} label="Show source pages" count={sourceCount} swatch={<Dot color="var(--fg-muted)" on={filters.showSources} faint />}
              onToggle={() => onFilters({ ...filters, showSources: !filters.showSources })} />
            <Row on={includeArchived} label="Show archived" swatch={<Dot color="var(--fg-dim)" on={includeArchived} faint />}
              onToggle={() => onIncludeArchived(!includeArchived)} />
          </Section>
        </>
      )}
    </div>
  );
}

/** "Part of / Includes" for a one-way type, "Competes with" for a two-way one. */
function labelPair(type: string): string {
  const [out, inn] = [relationLabel(type, 'out'), relationLabel(type, 'in')];
  return out === inn ? out : `${out} / ${inn}`;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <h3 style={HEADING}>{title}</h3>
      {children}
    </section>
  );
}

const ROW: CSSProperties = {
  position: 'relative', display: 'flex', alignItems: 'center', gap: 10, minHeight: 24, cursor: 'pointer',
  userSelect: 'none', fontFamily: 'var(--font-body)', fontSize: 12, lineHeight: '16px',
};

function Row(props: { on: boolean; label: string; count?: number; swatch: ReactNode; onToggle(): void }) {
  return (
    <label className="graph-legend-row" style={{ ...ROW, color: props.on ? 'var(--fg-secondary)' : 'var(--fg-dim)' }}>
      <input type="checkbox" checked={props.on} onChange={props.onToggle} style={HIDDEN_INPUT} />
      <span style={{ width: 18, display: 'flex', justifyContent: 'center', flexShrink: 0 }}>{props.swatch}</span>
      <span style={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{props.label}</span>
      {props.count !== undefined && <span style={{ color: 'var(--fg-dim)', fontVariantNumeric: 'tabular-nums' }}>{props.count}</span>}
    </label>
  );
}

function KeyRow({ color, label }: { color: string; label: string }) {
  return (
    <div style={{ ...ROW, cursor: 'default', color: 'var(--fg-secondary)' }}>
      <span style={{ width: 18, display: 'flex', justifyContent: 'center', flexShrink: 0 }}><Bar color={color} on /></span>
      <span>{label}</span>
    </div>
  );
}

function Dot({ color, on, ring = false, faint = false }: { color: string; on: boolean; ring?: boolean; faint?: boolean }) {
  return (
    <span
      style={{
        width: 9, height: 9, borderRadius: '50%', display: 'inline-block', border: `1.5px solid ${color}`,
        background: on ? color : 'transparent', opacity: faint && on ? 0.6 : 1,
        boxShadow: ring ? '0 0 0 2px #121316, 0 0 0 3px rgba(236,236,240,0.55)' : undefined,
      }}
    />
  );
}

function Bar({ color, on, thin = false }: { color: string; on: boolean; thin?: boolean }) {
  return <span style={{ width: 16, height: thin ? 1.5 : 3, borderRadius: 2, display: 'inline-block', background: color, opacity: on ? 1 : 0.35 }} />;
}
