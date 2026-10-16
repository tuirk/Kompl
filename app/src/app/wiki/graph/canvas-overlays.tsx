'use client';

/**
 * What floats over the graph canvas: the hover card that follows the
 * pointer (kept inside the window, flipping left or up near an edge) and the
 * zoom buttons. Inline styles and CSS vars, as the rest of the app.
 */

import type { RefObject } from 'react';

/** Gap between the pointer and the card, and the card and the window edge. */
const CARD_OFFSET = 14;
const EDGE = 8;

/**
 * The card's top-left corner for a pointer at (x, y): below and right of
 * it, or left of it / above it when the card would leave the window.
 */
export function cardPosition(
  x: number, y: number, cardW: number, cardH: number, viewW: number, viewH: number
): { left: number; top: number } {
  let left = x + CARD_OFFSET;
  if (left + cardW > viewW - EDGE) left = x - CARD_OFFSET - cardW;
  let top = y + CARD_OFFSET;
  if (top + cardH > viewH - EDGE) top = y - CARD_OFFSET - cardH;
  return { left: Math.max(EDGE, left), top: Math.max(EDGE, top) };
}

/** Moves the card next to the pointer; a DOM write, so the pointer never re-renders React. */
export function moveCard(card: HTMLElement | null, clientX: number, clientY: number): void {
  if (!card) return;
  const { left, top } = cardPosition(clientX, clientY, card.offsetWidth, card.offsetHeight, window.innerWidth, window.innerHeight);
  card.style.transform = `translate(${left}px, ${top}px)`;
}

/** Always mounted, so the pointer keeps its position current between hovers. */
export function HoverCard({ cardRef, card }: { cardRef: RefObject<HTMLDivElement | null>; card: { title: string; detail: string } | null }) {
  return (
    <div
      ref={cardRef}
      aria-hidden
      style={{
        position: 'fixed', left: 0, top: 0, zIndex: 50, pointerEvents: 'none', maxWidth: 280,
        visibility: card ? 'visible' : 'hidden',
        padding: '8px 10px', background: 'rgba(24,26,28,0.94)', border: '1px solid rgba(71,72,74,0.4)',
        fontFamily: 'var(--font-body)', fontSize: 12, lineHeight: '17px', color: 'var(--fg-secondary)',
      }}
    >
      <div style={{ fontFamily: 'var(--font-heading)', fontWeight: 700, fontSize: 13, color: 'var(--fg)' }}>{card?.title}</div>
      <div style={{ color: 'var(--fg-dim)' }}>{card?.detail}</div>
    </div>
  );
}

/** Zoom in, zoom out and fit, bottom right of the canvas (left of an open panel). */
export function ZoomButtons({ right, onZoom, onFit }: { right: number; onZoom(factor: number): void; onFit(): void }) {
  const buttons = [
    { label: '+', title: 'Zoom in', run: () => onZoom(1.3) },
    { label: '−', title: 'Zoom out', run: () => onZoom(0.77) },
    { label: '⊙', title: 'Fit the map', run: onFit },
  ];
  return (
    <div style={{ position: 'absolute', right, bottom: 16, display: 'flex', flexDirection: 'column', gap: 6 }}>
      {buttons.map((b) => (
        <button
          key={b.label}
          type="button"
          title={b.title}
          aria-label={b.title}
          onClick={b.run}
          style={{
            width: 36, height: 36, display: 'flex', alignItems: 'center', justifyContent: 'center',
            background: 'rgba(36,38,41,0.7)', border: '1px solid rgba(71,72,74,0.3)', color: 'var(--fg)',
            fontFamily: 'var(--font-mono)', fontSize: b.label === '⊙' ? 14 : 18, cursor: 'pointer',
          }}
        >
          {b.label}
        </button>
      ))}
    </div>
  );
}
