/**
 * Colours for the knowledge graph canvas (app/wiki/graph). Canvas cannot read
 * CSS vars, so these are raw hex. Client-safe: no DB imports.
 *
 * CATEGORY_HEX colours the topic islands, biggest category first. It starts
 * from the six Okabe-Ito colours that read on a near-black canvas, which
 * stay distinguishable under the common colour-vision deficiencies, and adds
 * a violet and a sage green chosen to sit as far as possible from those six
 * and each other (OKLab, in normal vision and simulated red-green colour
 * blindness). Okabe-Ito's dark blue, lifted for the canvas, and a pale rose
 * read as the sky blue and the reddish purple, so two islands side by side
 * could look like one topic. Any two topics may end up side by side, so every
 * pair must differ (__tests__/graph-palette.test.ts). Categories past the
 * eighth share NEUTRAL_HEX; pages with no topic ("Uncategorized") have their
 * own lighter neutral, NO_TOPIC_HEX.
 *
 * Lines never use topic colours, and each line channel means one thing:
 * brightness is how specific the connection is (LINE_ALPHA: typed, then
 * "related to", then a plain link), width is how many sources say so, an
 * arrow or a zigzag is the kind of relation (graph-line-style.ts), and the
 * accent marks the clicked line or a path, as the accent ring marks the
 * selected page. Typed and "related to" lines and the accent reach 3:1
 * against CANVAS_BG (WCAG 1.4.11); plain links are deliberately faint (an
 * optional layer, off by default) and make no 3:1 claim.
 */

/** The graph's canvas background (also the page background). */
export const CANVAS_BG = '#0D0E10';

export const CATEGORY_HEX = [
  '#56B4E9', // sky blue
  '#E69F00', // orange
  '#009E73', // bluish green
  '#CC79A7', // reddish purple
  '#F0E442', // yellow
  '#D55E00', // vermillion
  '#7F63EE', // violet
  '#85C484', // sage green
] as const;

/** Categories beyond the eighth ("Other topics" in the legend). */
export const NEUTRAL_HEX = '#8B9099';

/** Pages with no topic: a pale grey, apart from NEUTRAL_HEX and every topic colour. */
export const NO_TOPIC_HEX = '#D0D3D8';

/** Every line's colour; the tiers differ in alpha only. */
export const LINE_HEX = '#D6DBE2';

/** Line alpha by kind: typed, only "related to", only a wikilink. */
export const LINE_ALPHA = { typed: 0.75, related: 0.55, plain: 0.4 } as const;

/** Lines away from what is hovered or selected. */
export const LINE_FADED = 0.06;

/** The lines of the hovered or selected page, and the hovered line. */
export const LINE_LIT_HEX = '#E6EDF3';

/** The selection ring and other accents (the app's --accent). */
export const ACCENT_HEX = '#98FFD9';

/** "#56B4E9" + 0.3 -> "rgba(86,180,233,0.3)". Build-time only: callers cache the result. */
export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
