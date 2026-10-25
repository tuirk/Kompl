'use client';

/**
 * The graph's legend, a map-app style control over the top left of the
 * canvas:
 *  - collapsed (the default on a first visit): a small "Filters" button,
 *    with a badge when filters differ from the default map ("3 changed");
 *  - expanded: the filter panel. A header ("Filters", an ⓘ button whose
 *    popover is the key "How to read the map", LegendKey.tsx, and
 *    "Collapse filters" ×), then every filter as a checkbox (checked =
 *    shown) with a noun label and a count: Topics, Pages (page types, source
 *    pages, missing pages, archived pages) and Lines ("related to" lines,
 *    plain links). Its bottom-right grip resizes it like a textarea.
 * The page keeps the expanded state and the size (usePanelSizes.ts), so the
 * map's fit leaves room for whichever is shown.
 */

import { useEffect, useId, useMemo, useRef } from 'react';
import { SlidersHorizontal, X } from 'lucide-react';
import { RING_PAGE_TYPES, type GraphFilters, type GraphModel, type VisibleGraph } from '../../../lib/graph-model';
import { changedFilters, legendCategoryGroups, legendPageTypes, type CategoryGroup } from '../../../lib/graph-legend';
import { MISSING_HEX } from '../../../lib/graph-missing';
import { MISSING_PAGE_MIN_SOURCES } from '../../../lib/missing-page-rules';
import { LEGEND_LEFT, LEGEND_TOP, legendRange, type LegendSize } from '../../../lib/graph-panels';
import { PAGE_TYPE_LABELS, type PageType } from '../../../lib/page-type-palette';
import { Dot, FilterRow, FiltersButton, ICON_BUTTON, LEGEND_HEADING } from './legend-parts';
import LegendKey from './LegendKey';
import LineSample, { SAMPLE_W } from './LineSamples';
import ResizeGrip from './ResizeGrip';

interface Props {
  model: GraphModel;
  visible: VisibleGraph;
  filters: GraphFilters;
  onFilters(next: GraphFilters): void;
  includeArchived: boolean;
  onIncludeArchived(next: boolean): void;
  /** Names with no page yet that the map can show; their filter is offered only when there are some. */
  missingCount: number;
  showMissing: boolean;
  onShowMissing(next: boolean): void;
  /** True when so many lines show that only typed ones answer the pointer. */
  pointerLimited: boolean;
  /** Expanded; the page keeps this, so the map's fit leaves room for it. */
  open: boolean;
  onOpen(next: boolean): void;
  /** The panel's size (the page keeps it) and how the grip changes it. */
  size: LegendSize;
  onSize(next: LegendSize): void;
  onSizeDone(): void;
}

const SUB_HEADING = { ...LEGEND_HEADING, fontSize: 9, margin: '8px 0 0', color: 'var(--fg-dim)' } as const;
const NOTE = { fontFamily: 'var(--font-body)', fontSize: 11, lineHeight: '15px', color: 'var(--fg-dim)' } as const;

function toggled<T>(set: ReadonlySet<T>, values: readonly T[]): Set<T> {
  const next = new Set(set);
  const allHidden = values.every((v) => next.has(v));
  for (const v of values) {
    if (allHidden) next.delete(v);
    else next.add(v);
  }
  return next;
}

/** "Entity pages", "Overviews"…: a page type as a noun. */
function typeLabel(type: string): string {
  const label = type in PAGE_TYPE_LABELS ? PAGE_TYPE_LABELS[type as PageType] : type.replace(/-/g, ' ');
  return label.charAt(0).toUpperCase() + label.slice(1);
}

export default function GraphLegend(props: Props) {
  const { model, visible, filters, onFilters, includeArchived, onIncludeArchived, missingCount, showMissing, onShowMissing } = props;
  const { pointerLimited, open, onOpen, size, onSize, onSizeDone } = props;
  const panelRef = useRef<HTMLElement>(null);
  const buttonRef = useRef<HTMLButtonElement>(null);
  const closeRef = useRef<HTMLButtonElement>(null);
  /** Where focus goes after the viewer expands or collapses (the control they used is gone). */
  const focusNext = useRef<'close' | 'button' | null>(null);
  const panelId = useId();
  const titleId = useId();
  const start = useRef(size);
  const count = (name: string) => visible.categoryCounts.get(name) ?? 0;
  // Lists that depend on the data only, worked out once per load.
  const groups = useMemo(() => legendCategoryGroups(model), [model]);
  const types = useMemo(() => legendPageTypes(model), [model]);
  const opposed = useMemo(() => model.links.some((l) => l.colorType === 'competes_with' || l.colorType === 'contradicts'), [model]);
  const sourceCount = useMemo(
    () => model.nodes.filter((n) => n.isSource && !filters.hiddenCategories.has(n.category)).length,
    [model, filters.hiddenCategories]
  );
  const changed = changedFilters(model, filters, { includeArchived, showMissing, missingCount });

  useEffect(() => {
    const target = focusNext.current === 'close' ? closeRef.current : focusNext.current === 'button' ? buttonRef.current : null;
    focusNext.current = null;
    target?.focus();
  }, [open]);
  const expand = () => {
    focusNext.current = 'close';
    onOpen(true);
  };
  const collapse = () => {
    focusNext.current = 'button';
    onOpen(false);
  };

  const categoryRow = ({ key, label, color, names }: CategoryGroup) => {
    const hidden = names.every((n) => filters.hiddenCategories.has(n));
    const n = names.reduce((s, name) => s + count(name), 0);
    if (n === 0 && !hidden) return null;
    return (
      <FilterRow key={key} on={!hidden} label={label} count={n} swatch={<Dot color={color} />}
        onToggle={() => onFilters({ ...filters, hiddenCategories: toggled(filters.hiddenCategories, names) })} />
    );
  };
  // The grip reports the change since the drag began; an unset height starts from the drawn height.
  const resize = (dx: number, dy: number, begin: boolean) => {
    if (begin) start.current = { width: size.width, height: size.height ?? panelRef.current?.offsetHeight ?? 400 };
    else onSize({ width: start.current.width + dx, height: (start.current.height ?? 400) + dy });
  };

  return (
    <>
      <FiltersButton open={open} controls={panelId} changed={changed} onExpand={expand} buttonRef={buttonRef} />
      <section
        ref={panelRef}
        id={panelId}
        aria-labelledby={titleId}
        data-legend="filters"
        hidden={!open}
        style={{
          position: 'absolute', left: LEGEND_LEFT, top: LEGEND_TOP, zIndex: 10, width: size.width,
          height: open && size.height !== null ? size.height : undefined, maxHeight: `calc(100% - ${2 * LEGEND_TOP}px)`,
          display: open ? 'flex' : 'none', flexDirection: 'column',
          background: 'rgba(18,19,22,0.9)', border: '1px solid rgba(71,72,74,0.25)', backdropFilter: 'blur(6px)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 4, padding: '6px 6px 6px 14px', borderBottom: '1px solid rgba(71,72,74,0.25)' }}>
          <SlidersHorizontal size={14} aria-hidden style={{ color: 'var(--fg-muted)', flexShrink: 0, marginRight: 4 }} />
          <h2 id={titleId} style={{ margin: 0, fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 10, lineHeight: '15px', letterSpacing: 1, textTransform: 'uppercase', color: 'var(--fg-secondary)' }}>
            Filters
          </h2>
          {open && <LegendKey opposed={opposed} missing={missingCount > 0} frame={panelRef} />}
          <span style={{ flex: 1 }} />
          <button ref={closeRef} type="button" className="graph-icon-btn" aria-label="Collapse filters" title="Collapse filters"
            aria-controls={panelId} onClick={collapse} style={ICON_BUTTON}>
            <X size={16} aria-hidden />
          </button>
        </div>
        <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: '8px 14px 12px', display: 'flex', flexDirection: 'column' }}>
          <span style={NOTE}>Checked = shown on the map</span>
          <h3 style={SUB_HEADING}>Topics</h3>
          {groups.map(categoryRow)}
          <h3 style={SUB_HEADING}>Pages</h3>
          {types.map((t) => (
            <FilterRow key={t} on={!filters.hiddenTypes.has(t)} label={typeLabel(t)} count={visible.typeCounts.get(t) ?? 0}
              swatch={<Dot color="var(--fg-muted)" ring={RING_PAGE_TYPES.has(t)} />}
              onToggle={() => onFilters({ ...filters, hiddenTypes: toggled(filters.hiddenTypes, [t]) })} />
          ))}
          <FilterRow on={filters.showSources} label="Source pages" count={sourceCount} swatch={<Dot color="var(--fg-muted)" faint />}
            onToggle={() => onFilters({ ...filters, showSources: !filters.showSources })} />
          {missingCount > 0 && (
            <>
              <FilterRow on={showMissing} label="Missing pages" count={missingCount} swatch={<Dot color={MISSING_HEX} dashed />}
                onToggle={() => onShowMissing(!showMissing)} />
              {/* A page panel lists every name with no page; this counts only those enough sources name. */}
              <span style={NOTE}>{`Names ${MISSING_PAGE_MIN_SOURCES} or more sources mention that have no page yet.`}</span>
            </>
          )}
          <FilterRow on={includeArchived} label="Archived pages" swatch={<Dot color="var(--fg-dim)" faint />}
            onToggle={() => onIncludeArchived(!includeArchived)} />
          <h3 style={SUB_HEADING}>Lines</h3>
          <FilterRow on={filters.showRelated} label="“Related to” lines" swatch={<LineSample kind="related" />} swatchWidth={SAMPLE_W}
            onToggle={() => onFilters({ ...filters, showRelated: !filters.showRelated })} />
          <FilterRow on={filters.showPlain} label="Plain links" swatch={<LineSample kind="plain" />} swatchWidth={SAMPLE_W}
            onToggle={() => onFilters({ ...filters, showPlain: !filters.showPlain })} />
          <span style={{ ...NOTE, marginTop: 4 }}>
            Typed relations always show.
            {pointerLimited && ' Many lines on screen: only typed lines respond to the pointer.'}
          </span>
        </div>
        {open && (
          <ResizeGrip label="Resize filters" grip="legend" range={legendRange(size.width)} controls={panelId}
            valueText={`${size.width} px wide, ${size.height === null ? 'as tall as its content' : `${size.height} px tall`}`}
            onResize={resize} onDone={onSizeDone} />
        )}
      </section>
    </>
  );
}
