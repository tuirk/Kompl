'use client';

/**
 * The legend's and the details panel's sizes on the graph page, and whether
 * the legend is expanded: the viewer's last choices from localStorage (read
 * once, on mount, so before the legend and the map first draw; a missing or
 * corrupt value gives the defaults: collapsed to its "Filters" button,
 * default sizes), sizes always clamped to the current canvas, and saved when
 * changed. Storage errors are ignored.
 */

import { useCallback, useEffect, useMemo, useState } from 'react';
import {
  clampSizes, DEFAULT_SIZES, LEGEND_OPEN_KEY, PANEL_SIZES_KEY, parseSizes, readStoredOpen, serializeSizes, writeStoredOpen,
  type LegendSize, type PanelSizes,
} from '../../../lib/graph-panels';

export function usePanelSizes(canvasWidth: number, canvasHeight: number) {
  const [raw, setRaw] = useState<PanelSizes>(DEFAULT_SIZES);
  const [saves, setSaves] = useState(0);
  const [legendOpen, setLegendOpenState] = useState(false);
  // On mount, while the graph data is still loading: the legend and the first fit use these.
  useEffect(() => {
    setLegendOpenState(readStoredOpen(LEGEND_OPEN_KEY));
    try {
      setRaw(parseSizes(window.localStorage.getItem(PANEL_SIZES_KEY)));
    } catch {
      // Storage unavailable: keep the defaults.
    }
  }, []);
  /** Expands or collapses the legend and keeps the choice. */
  const setLegendOpen = useCallback((open: boolean) => {
    setLegendOpenState(open);
    writeStoredOpen(LEGEND_OPEN_KEY, open);
  }, []);
  const sizes = useMemo(
    () => (canvasWidth > 0 ? clampSizes(raw, canvasWidth, canvasHeight) : raw),
    [raw, canvasWidth, canvasHeight]
  );

  const setLegend = useCallback((legend: LegendSize) => setRaw((s) => ({ ...s, legend })), []);
  const setPanel = useCallback((panel: number) => setRaw((s) => ({ ...s, panel })), []);
  // Saving waits for the render that applies the last drag step (pointer moves render later than the release).
  const save = useCallback(() => setSaves((n) => n + 1), []);
  useEffect(() => {
    if (saves === 0) return;
    try {
      // What is on screen (the clamped sizes), so a later, smaller window starts from a sane size.
      window.localStorage.setItem(PANEL_SIZES_KEY, serializeSizes(sizes));
    } catch {
      // Storage unavailable: the size lasts until the page is left.
    }
    // `sizes` is read as of this save only.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [saves]);

  /** What the details panel's shell reads (PanelWidthContext). */
  const panelContext = useMemo(() => ({ width: sizes.panel, onWidth: setPanel, onDone: save }), [sizes.panel, setPanel, save]);

  return { sizes, setLegend, save, panelContext, legendOpen, setLegendOpen };
}
