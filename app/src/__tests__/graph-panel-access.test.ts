/**
 * Keyboard and pointer rules of the graph's floating panels
 * (lib/graph-panels.ts): where keyboard focus goes when a details panel
 * closes, and the resize grips as window splitters (arrow keys, Home and
 * End, the limits read out) whose drags end cleanly when cancelled.
 */

import { describe, expect, it } from 'vitest';
import {
  focusTargetOnClose, gripDragDelta, gripKeyStep, LEGEND_MAX_WIDTH, LEGEND_MIN, legendRange, PANEL_MIN_WIDTH, panelRange,
  RESIZE_STEP,
} from '../lib/graph-panels';

/** A stand-in element: connected or not, and inside the panel or not. */
function el(name: string, connected = true): HTMLElement {
  return { name, isConnected: connected } as unknown as HTMLElement;
}

describe('focus when a details panel closes', () => {
  const body = el('body');
  const canvas = el('canvas box');
  const opener = el('legend button');
  const heading = el('panel heading');
  const checkbox = el('topic checkbox');
  const panel = { contains: (node: Node | null) => node === (heading as unknown as Node) };

  it('hands focus back to what had it before, when focus was in the panel', () => {
    expect(focusTargetOnClose(heading, body, panel, opener, canvas)).toBe(opener);
  });

  it('hands it back when focus was lost to the page (the focused control went with the panel)', () => {
    expect(focusTargetOnClose(body, body, panel, opener, canvas)).toBe(opener);
    expect(focusTargetOnClose(null, body, panel, opener, canvas)).toBe(opener);
  });

  it('falls back to the canvas when the earlier element is gone or was the page itself', () => {
    expect(focusTargetOnClose(heading, body, panel, el('removed', false), canvas)).toBe(canvas);
    expect(focusTargetOnClose(heading, body, panel, body, canvas)).toBe(canvas);
    expect(focusTargetOnClose(heading, body, panel, null, canvas)).toBe(canvas);
  });

  it('leaves focus where the viewer put it: a legend checkbox that hid the selected page', () => {
    expect(focusTargetOnClose(checkbox, body, panel, opener, canvas)).toBeNull();
    expect(focusTargetOnClose(canvas, body, panel, opener, canvas)).toBeNull();
  });
});

describe('resize grips as window splitters', () => {
  it('reads out the width and its limits: the panel up to half the canvas, the legend up to 420 px', () => {
    expect(panelRange(360, 1600)).toEqual({ value: 360, min: PANEL_MIN_WIDTH, max: 800 });
    expect(panelRange(300, 500)).toEqual({ value: 300, min: PANEL_MIN_WIDTH, max: PANEL_MIN_WIDTH });
    expect(legendRange(236)).toEqual({ value: 236, min: LEGEND_MIN.width, max: LEGEND_MAX_WIDTH });
  });

  it('moves 16 px per arrow key, and Home / End go to the narrowest and widest', () => {
    const panel = panelRange(360, 1600);
    expect(gripKeyStep('ArrowLeft', 'panel', panel)).toEqual([RESIZE_STEP, 0]);
    expect(gripKeyStep('Home', 'panel', panel)).toEqual([PANEL_MIN_WIDTH - 360, 0]);
    expect(gripKeyStep('End', 'panel', panel)).toEqual([800 - 360, 0]);
    const legend = legendRange(236);
    expect(gripKeyStep('ArrowDown', 'legend', legend)).toEqual([0, RESIZE_STEP]);
    expect(gripKeyStep('Home', 'legend', legend)).toEqual([LEGEND_MIN.width - 236, 0]);
    expect(gripKeyStep('End', 'legend', legend)).toEqual([LEGEND_MAX_WIDTH - 236, 0]);
    expect(gripKeyStep('Enter', 'legend', legend)).toBeNull();
  });
});

describe('resize grip drags', () => {
  const drag = { x: 900, y: 500, pointerId: 1 };
  const at = (type: string, clientX: number, clientY: number, pointerId = 1) => ({ type, pointerId, clientX, clientY });

  it('applies the change since the drag began while moving and on release', () => {
    expect(gripDragDelta(drag, at('pointermove', 860, 520))).toEqual([-40, 20]);
    expect(gripDragDelta(drag, at('pointerup', 850, 500))).toEqual([-50, 0]);
  });

  it('applies nothing for a cancel, whose coordinates can be 0,0, nor for a lost capture', () => {
    expect(gripDragDelta(drag, at('pointercancel', 0, 0))).toBeNull();
    expect(gripDragDelta(drag, at('lostpointercapture', 0, 0))).toBeNull();
  });

  it('ignores another pointer and events after the drag ended', () => {
    expect(gripDragDelta(drag, at('pointermove', 10, 10, 2))).toBeNull();
    expect(gripDragDelta(null, at('pointermove', 10, 10))).toBeNull();
  });
});
