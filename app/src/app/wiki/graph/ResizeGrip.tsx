'use client';

/**
 * A resize grip for the graph's floating panels: three diagonal lines in a
 * corner, as on a textarea. Drag it (pointer capture, so the drag keeps
 * going outside the grip) or focus it and use the arrow keys (16 px a
 * press, lib/graph-panels.ts resizeStep). `onResize` gets the change in
 * pixels since the drag started; `onDone` fires when a drag or a key press
 * ends, for saving the size.
 */

import { useRef, type KeyboardEvent, type PointerEvent } from 'react';
import { resizeStep } from '../../../lib/graph-panels';

interface Props {
  label: string;
  /** 'legend': bottom-right corner, both ways; 'panel': bottom-left corner, width only. */
  grip: 'legend' | 'panel';
  /**
   * Called with `start` true when a drag or a key step begins (the parent notes
   * the size then), then with [dx, dy] since that start for each change.
   */
  onResize(dx: number, dy: number, start: boolean): void;
  onDone(): void;
}

export default function ResizeGrip({ label, grip, onResize, onDone }: Props) {
  const from = useRef<{ x: number; y: number; id: number } | null>(null);
  const corner = grip === 'legend' ? { right: 0, bottom: 0 } : { left: 0, bottom: 0 };

  const down = (e: PointerEvent<HTMLButtonElement>) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    from.current = { x: e.clientX, y: e.clientY, id: e.pointerId };
    onResize(0, 0, true);
  };
  const move = (e: PointerEvent<HTMLButtonElement>) => {
    if (from.current?.id !== e.pointerId) return;
    onResize(e.clientX - from.current.x, e.clientY - from.current.y, false);
  };
  const up = (e: PointerEvent<HTMLButtonElement>) => {
    if (from.current?.id !== e.pointerId) return;
    // The last step goes in with onDone, in one update, so what is saved is what is shown.
    onResize(e.clientX - from.current.x, e.clientY - from.current.y, false);
    from.current = null;
    e.currentTarget.releasePointerCapture(e.pointerId);
    onDone();
  };
  const key = (e: KeyboardEvent<HTMLButtonElement>) => {
    const step = resizeStep(e.key, grip);
    if (!step) return;
    e.preventDefault();
    onResize(0, 0, true);
    // The panel grows leftwards: a drag to the left is a negative dx, as a key step towards the left.
    onResize(grip === 'panel' ? -step[0] : step[0], step[1], false);
    onDone();
  };

  return (
    <button
      type="button"
      className="graph-header-btn"
      aria-label={label}
      title={`${label} (drag, or use the arrow keys)`}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onKeyDown={key}
      style={{
        position: 'absolute', ...corner, width: 18, height: 18, padding: 0, border: 'none', background: 'none',
        cursor: grip === 'legend' ? 'nwse-resize' : 'nesw-resize', touchAction: 'none', zIndex: 2,
      }}
    >
      <svg width={18} height={18} viewBox="0 0 18 18" aria-hidden style={{ display: 'block', transform: grip === 'panel' ? 'scaleX(-1)' : undefined }}>
        <path d="M16 6 L6 16 M16 10 L10 16 M16 14 L14 16" stroke="var(--fg-muted)" strokeWidth={1.25} strokeLinecap="round" />
      </svg>
    </button>
  );
}
