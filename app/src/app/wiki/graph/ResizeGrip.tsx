'use client';

/**
 * A resize grip for the graph's floating panels: three diagonal lines in a
 * corner, as on a textarea, and a focusable window splitter for keyboards
 * and screen readers (role="separator" with the width and its limits). Drag
 * it (pointer capture, so the drag keeps going outside the grip) or focus it
 * and use the arrow keys (16 px a press) or Home / End (narrowest / widest),
 * lib/graph-panels.ts. `onResize` gets the change in pixels since the drag
 * started; `onDone` fires when a drag or a key press ends, for saving the
 * size. A cancelled drag, or one that loses its capture, stops at the size
 * last shown.
 */

import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { gripDragDelta, gripKeyStep, type GripDrag, type GripRange } from '../../../lib/graph-panels';

interface Props {
  label: string;
  /** 'legend': bottom-right corner, both ways; 'panel': bottom-left corner, width only. */
  grip: 'legend' | 'panel';
  /** The width it sets now and its limits. */
  range: GripRange;
  /** The id of the panel it resizes. */
  controls?: string;
  /** How the size reads out, e.g. "360 px wide". */
  valueText: string;
  /**
   * Called with `start` true when a drag or a key step begins (the parent notes
   * the size then), then with [dx, dy] since that start for each change.
   */
  onResize(dx: number, dy: number, start: boolean): void;
  onDone(): void;
}

export default function ResizeGrip({ label, grip, range, controls, valueText, onResize, onDone }: Props) {
  const from = useRef<GripDrag | null>(null);
  const corner = grip === 'legend' ? { right: 0, bottom: 0 } : { left: 0, bottom: 0 };

  const down = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    from.current = { x: e.clientX, y: e.clientY, pointerId: e.pointerId };
    onResize(0, 0, true);
  };
  const move = (e: PointerEvent<HTMLDivElement>) => {
    const d = gripDragDelta(from.current, e);
    if (d) onResize(d[0], d[1], false);
  };
  // A release applies its last step with onDone, in one update, so what is saved is what is shown;
  // a cancel or a lost capture applies none (its coordinates can be 0,0).
  const end = (e: PointerEvent<HTMLDivElement>) => {
    if (from.current?.pointerId !== e.pointerId) return;
    const d = gripDragDelta(from.current, e);
    if (d) onResize(d[0], d[1], false);
    from.current = null;
    if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId);
    onDone();
  };
  const key = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = gripKeyStep(e.key, grip, range);
    if (!step) return;
    e.preventDefault();
    onResize(0, 0, true);
    // The panel grows leftwards: a drag to the left is a negative dx, as a key step towards the left.
    onResize(grip === 'panel' ? -step[0] : step[0], step[1], false);
    onDone();
  };

  return (
    <div
      role="separator"
      tabIndex={0}
      className="graph-header-btn"
      aria-label={label}
      aria-orientation="vertical"
      aria-valuenow={range.value}
      aria-valuemin={range.min}
      aria-valuemax={range.max}
      aria-valuetext={valueText}
      aria-controls={controls}
      title={`${label} (drag, or use the arrow keys)`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={end}
      onPointerCancel={end}
      onLostPointerCapture={end}
      onKeyDown={key}
      style={{
        position: 'absolute', ...corner, width: 18, height: 18, padding: 0, border: 'none', background: 'none',
        cursor: grip === 'legend' ? 'nwse-resize' : 'nesw-resize', touchAction: 'none', zIndex: 2,
      }}
    >
      <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden style={{ display: 'block', transform: grip === 'panel' ? 'scaleX(-1)' : undefined }}>
        <path d="M16 6 L6 16 M16 10 L10 16 M16 14 L14 16" stroke="var(--fg-muted)" strokeWidth={1.25} strokeLinecap="round" />
      </svg>
    </div>
  );
}
