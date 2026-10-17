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
