/**
 * Colours for the knowledge graph canvas (app/wiki/graph). Canvas cannot read
 * CSS vars, so these are raw hex. Client-safe: no DB imports.
 *
 * CATEGORY_HEX colours the topic islands, biggest category first. It starts
 * from the Okabe-Ito set, which stays distinguishable under the common
 * colour-vision deficiencies, with the darkest blue lifted for the near-black
 * canvas and a pale rose as the eighth colour. The colours differ in
 * lightness as well as hue (pale yellow, mid orange, deep blue), so
 * neighbouring islands still separate when hue does not. "Uncategorized" and
 * every category past the eighth share NEUTRAL_HEX.
 *
 * RELATION_HEX colours a line by its strongest relation type; "related to"
 * and plain links are greys, so the specific relations stand out.
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
  '#3D8BD0', // blue (Okabe-Ito #0072B2, lifted for the dark canvas)
  '#F4A3B4', // pale rose
] as const;

/** Uncategorized pages and categories beyond the eighth. */
export const NEUTRAL_HEX = '#8B9099';

/** Line colour per relation type; Includes / Used by / Created share their type's colour. */
export const RELATION_HEX: Record<string, string> = {
  part_of: '#7DD3FC',
  created_by: '#FCD34D',
  uses: '#86EFAC',
  competes_with: '#F87171',
  contradicts: '#E879F9',
  related_to: '#6B7280',
};

/** Any other relation type the extractor emits. */
export const OTHER_RELATION_HEX = '#C4B5FD';

/** Lines that are only a wikilink in the page text. */
export const PLAIN_LINK_HEX = '#4B5361';

/** The selection ring and other accents (the app's --accent). */
export const ACCENT_HEX = '#98FFD9';

export function relationHex(type: string): string {
  return RELATION_HEX[type] ?? OTHER_RELATION_HEX;
}

/** "#56B4E9" + 0.3 -> "rgba(86,180,233,0.3)". Build-time only: callers cache the result. */
export function withAlpha(hex: string, alpha: number): string {
  const n = parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255},${(n >> 8) & 255},${n & 255},${alpha})`;
}
