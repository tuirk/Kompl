/**
 * The sizes of the graph page's two floating panels, which the viewer can
 * drag (or move with the arrow keys) like a textarea's corner: the legend
 * (width and height) and the details panel on the right (width). Limits,
 * keyboard steps, what is kept in localStorage, and the canvas edges the map
 * keeps clear of for those sizes. Pure; the storage helpers take the raw
 * string so a missing or corrupt value never breaks the page.
 */

import type { ViewInsets } from './graph-layout';

export const LEGEND_LEFT = 16;
export const LEGEND_TOP = 16;
/** The collapsed legend: the "Filters" button's height. */
export const FILTERS_BUTTON_HEIGHT = 32;
export const LEGEND_DEFAULT_WIDTH = 236;
export const LEGEND_MIN = { width: 200, height: 160 } as const;
export const LEGEND_MAX_WIDTH = 420;
export const PANEL_DEFAULT_WIDTH = 360;
export const PANEL_MIN_WIDTH = 300;
/** The details panel never covers more than this share of the canvas. */
const PANEL_MAX_SHARE = 0.5;
/** One arrow-key press on a resize grip. */
export const RESIZE_STEP = 16;
export const PANEL_SIZES_KEY = 'kompl.graph.panelSizes';

export interface LegendSize {
  width: number;
  /** null: as tall as its content (up to the canvas). */
  height: number | null;
}

export interface PanelSizes {
  legend: LegendSize;
  panel: number;
}

export const DEFAULT_SIZES: PanelSizes = { legend: { width: LEGEND_DEFAULT_WIDTH, height: null }, panel: PANEL_DEFAULT_WIDTH };

const clamp = (v: number, min: number, max: number) => Math.min(Math.max(v, min), Math.max(min, max));

/** The legend within its limits on a canvas `canvasHeight` tall (it keeps 16 px clear above and below). */
export function clampLegend(size: LegendSize, canvasHeight: number): LegendSize {
  return {
    width: clamp(size.width, LEGEND_MIN.width, LEGEND_MAX_WIDTH),
    height: size.height === null ? null : clamp(size.height, LEGEND_MIN.height, canvasHeight - 2 * LEGEND_TOP),
  };
}

/** The details panel's width within its limits on a canvas `canvasWidth` wide. */
export function clampPanel(width: number, canvasWidth: number): number {
  return clamp(width, PANEL_MIN_WIDTH, Math.floor(canvasWidth * PANEL_MAX_SHARE));
}

export function clampSizes(sizes: PanelSizes, canvasWidth: number, canvasHeight: number): PanelSizes {
  return { legend: clampLegend(sizes.legend, canvasHeight), panel: clampPanel(sizes.panel, canvasWidth) };
}

/**
 * How an arrow key moves a resize grip: [dWidth, dHeight] in pixels, or null
 * for any other key. The details panel grows leftwards, so ArrowLeft widens it.
 */
export function resizeStep(key: string, grip: 'legend' | 'panel'): [number, number] | null {
  if (grip === 'panel') {
    if (key === 'ArrowLeft') return [RESIZE_STEP, 0];
    if (key === 'ArrowRight') return [-RESIZE_STEP, 0];
    return null;
  }
  switch (key) {
    case 'ArrowRight': return [RESIZE_STEP, 0];
    case 'ArrowLeft': return [-RESIZE_STEP, 0];
    case 'ArrowDown': return [0, RESIZE_STEP];
    case 'ArrowUp': return [0, -RESIZE_STEP];
    default: return null;
  }
}

/** A grip's width now and its limits: read out by screen readers, and where Home and End go. */
export interface GripRange {
  value: number;
  min: number;
  max: number;
}

export function panelRange(width: number, canvasWidth: number): GripRange {
  return { value: width, min: PANEL_MIN_WIDTH, max: clampPanel(Infinity, canvasWidth) };
}

export function legendRange(width: number): GripRange {
  return { value: width, min: LEGEND_MIN.width, max: LEGEND_MAX_WIDTH };
}

/**
 * How a key moves a resize grip, [dWidth, dHeight]: the arrow keys as
 * resizeStep, Home and End to the narrowest and widest (the window splitter
 * pattern). Null for any other key.
 */
export function gripKeyStep(key: string, grip: 'legend' | 'panel', range: GripRange): [number, number] | null {
  if (key === 'Home') return [range.min - range.value, 0];
  if (key === 'End') return [range.max - range.value, 0];
  return resizeStep(key, grip);
}

/** Where a grip drag began, and with which pointer. */
export interface GripDrag {
  x: number;
  y: number;
  pointerId: number;
}

/** The bits of a pointer event a grip drag reads (a PointerEvent fits). */
export interface GripPointer {
  type: string;
  pointerId: number;
  clientX: number;
  clientY: number;
}

/**
 * The change since the drag began that a pointer event applies, [dx, dy]:
 * none for another pointer or after the drag, and none when the drag is
 * cancelled or loses its pointer capture. A cancel's coordinates can be 0,0,
 * which would snap the panel to a limit and save that.
 */
export function gripDragDelta(drag: GripDrag | null, e: GripPointer): [number, number] | null {
  if (drag === null || e.pointerId !== drag.pointerId) return null;
  if (e.type === 'pointercancel' || e.type === 'lostpointercapture') return null;
  return [e.clientX - drag.x, e.clientY - drag.y];
}

const isSize = (v: unknown, min: number): v is number => typeof v === 'number' && Number.isFinite(v) && v >= min / 2 && v < 10_000;

/** The stored sizes, falling back to the defaults for anything missing, corrupt or absurd. */
export function parseSizes(raw: string | null | undefined): PanelSizes {
  if (!raw) return DEFAULT_SIZES;
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    return DEFAULT_SIZES;
  }
  const d = (data && typeof data === 'object' ? data : {}) as { legend?: { width?: unknown; height?: unknown }; panel?: unknown };
  const [w, h, p] = [d.legend?.width, d.legend?.height, d.panel];
  const width = isSize(w, LEGEND_MIN.width) ? w : LEGEND_DEFAULT_WIDTH;
  const height = isSize(h, LEGEND_MIN.height) ? h : null;
  const panel = isSize(p, PANEL_MIN_WIDTH) ? p : PANEL_DEFAULT_WIDTH;
  return { legend: { width, height }, panel };
}

export function serializeSizes(sizes: PanelSizes): string {
  return JSON.stringify(sizes);
}

/**
 * The canvas edges the map keeps clear of when fitting and gliding: the
 * legend (expanded: its width plus a margin; collapsed: only the "Filters"
 * button, a band along the top), an open details panel, and the zoom
 * buttons on the right.
 */
export function canvasInsets(legendOpen: boolean, legendWidth: number, panelOpen: boolean, panelWidth: number): ViewInsets {
  return {
    left: legendOpen ? LEGEND_LEFT + legendWidth + 16 : 24,
    top: legendOpen ? 44 : LEGEND_TOP + FILTERS_BUTTON_HEIGHT + 16,
    right: panelOpen ? panelWidth + 24 : 64,
    bottom: 40,
  };
}

/**
 * Where keyboard focus goes when a details panel closes: back to what had it
 * before the panel opened (or `fallback`, the canvas, when that is gone or
 * was the page itself), but only when focus was inside the panel or is lost
 * to the page. Focus the viewer moved elsewhere, e.g. to a legend checkbox
 * that hid the selected page, stays there (null).
 */
export function focusTargetOnClose(
  active: Element | null, body: HTMLElement, panel: Pick<Node, 'contains'> | null,
  before: HTMLElement | null, fallback: HTMLElement | null
): HTMLElement | null {
  const lost = active === null || active === body || (panel !== null && panel.contains(active));
  if (!lost) return null;
  return before !== null && before !== body && before.isConnected ? before : fallback;
}

/** Whether the legend is expanded, kept per viewer like the wiki sidebar's sections. */
export const LEGEND_OPEN_KEY = 'kompl.graph.legendOpen';

type OpenStore = Pick<Storage, 'getItem' | 'setItem'>;
const browserStore = (): OpenStore => window.localStorage;

/**
 * A stored expanded/collapsed choice: expanded only if the viewer expanded it
 * last time ('1'), collapsed after '0'. Missing, unreadable or corrupt
 * storage means collapsed (a first visit). No screen-size rule: the viewer's
 * choice holds everywhere.
 */
export function readStoredOpen(storageKey: string, store: () => OpenStore = browserStore): boolean {
  try {
    return store().getItem(storageKey) === '1';
  } catch {
    return false;
  }
}

/** Keeps the viewer's choice; storage errors are ignored (it then starts collapsed next time). */
export function writeStoredOpen(storageKey: string, open: boolean, store: () => OpenStore = browserStore): void {
  try {
    store().setItem(storageKey, open ? '1' : '0');
  } catch {
    // Private mode or storage off.
  }
}
