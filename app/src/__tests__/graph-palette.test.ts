/**
 * The topic colours on the knowledge graph (lib/graph-palette.ts): every
 * pair tells apart clearly, in normal vision and with red-green colour
 * blindness, whichever two topics end up side by side on the map; each
 * reaches 3:1 against the dark canvas; and pages with no topic have their
 * own neutral, apart from the grey of the topics past the eighth.
 */

import { describe, expect, it } from 'vitest';
import { CANVAS_BG, CATEGORY_HEX, NEUTRAL_HEX, NO_TOPIC_HEX } from '../lib/graph-palette';

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) / 255);
const lin = (c: number) => (c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4);
const luminance = (h: string) => {
  const [r, g, b] = rgb(h).map(lin);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (h: string) => (luminance(h) + 0.05) / (luminance(CANVAS_BG) + 0.05);

/** Machado et al. 2009, severity 1, on linear RGB. */
const SIMULATE: Record<string, number[][] | null> = {
  normal: null,
  deuteranopia: [[0.367322, 0.860646, -0.227968], [0.280085, 0.672501, 0.047413], [-0.01182, 0.04294, 0.968881]],
  protanopia: [[0.152286, 1.052583, -0.204868], [0.114503, 0.786281, 0.099216], [-0.003882, -0.048116, 1.051998]],
};

/** OKLab of a colour as seen with `vision`. */
function oklab(hex: string, vision: string): number[] {
  let c = rgb(hex).map(lin);
  const m = SIMULATE[vision];
  if (m) c = m.map((row) => Math.min(1, Math.max(0, row[0] * c[0] + row[1] * c[1] + row[2] * c[2])));
  const [l, mm, s] = [
    0.4122214708 * c[0] + 0.5363325363 * c[1] + 0.0514459929 * c[2],
    0.2119034982 * c[0] + 0.6806995451 * c[1] + 0.1073969566 * c[2],
    0.0883024619 * c[0] + 0.2817188376 * c[1] + 0.6299787005 * c[2],
  ].map(Math.cbrt);
  return [
    0.2104542553 * l + 0.793617785 * mm - 0.0040720468 * s,
    1.9779984951 * l - 2.428592205 * mm + 0.4505937099 * s,
    0.0259040371 * l + 0.7827717662 * mm - 0.808675766 * s,
  ];
}
const distance = (a: string, b: string, vision: string) => {
  const [x, y] = [oklab(a, vision), oklab(b, vision)];
  return Math.hypot(x[0] - y[0], x[1] - y[1], x[2] - y[2]);
};
const pairs = <T,>(list: readonly T[]) => list.flatMap((a, i) => list.slice(i + 1).map((b) => [a, b] as const));

describe('topic colours', () => {
  it('reach 3:1 against the canvas, the neutrals too', () => {
    for (const hex of [...CATEGORY_HEX, NEUTRAL_HEX, NO_TOPIC_HEX]) expect(contrast(hex), hex).toBeGreaterThanOrEqual(3);
  });

  it('tell every pair apart clearly (the old blues were 0.12 apart, rose and purple 0.13)', () => {
    for (const [a, b] of pairs(CATEGORY_HEX)) expect(distance(a, b, 'normal'), `${a} ${b}`).toBeGreaterThan(0.14);
  });

  it('stay apart with red-green colour blindness as well as the Okabe-Ito base allows', () => {
    // Okabe-Ito's own bluish green and reddish purple are the closest pair here (0.076).
    for (const vision of ['deuteranopia', 'protanopia']) {
      for (const [a, b] of pairs(CATEGORY_HEX)) expect(distance(a, b, vision), `${vision} ${a} ${b}`).toBeGreaterThan(0.07);
    }
  });

  it('give "no topic" a neutral of its own, apart from the topics and the overflow grey', () => {
    expect(distance(NO_TOPIC_HEX, NEUTRAL_HEX, 'normal')).toBeGreaterThan(0.14);
    for (const hex of CATEGORY_HEX) expect(distance(NO_TOPIC_HEX, hex, 'normal'), hex).toBeGreaterThan(0.14);
  });
});
