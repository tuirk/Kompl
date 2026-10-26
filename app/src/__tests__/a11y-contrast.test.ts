/**
 * Colour contrast (WCAG AA, 4.5:1 for body-size text) of the theme's text
 * tokens and page-type colours, found failing by the desktop browser crawl.
 * The theme is dark only; there is no light palette to check.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { PAGE_TYPE_HEX } from '../lib/page-type-palette';

// ── WCAG contrast ────────────────────────────────────────────────────────────

function luminance(hex: string): number {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
    .map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}
function contrast(a: string, b: string): number {
  const [x, y] = [luminance(a), luminance(b)];
  return (Math.max(x, y) + 0.05) / (Math.min(x, y) + 0.05);
}
/** `fg` at `alpha` over `bg`, as the browser composites it. */
function over(fg: string, bg: string, alpha: number): string {
  const ch = (h: string, i: number) => parseInt(h.slice(i, i + 2), 16);
  return '#' + [1, 3, 5]
    .map((i) => Math.round(ch(fg, i) * alpha + ch(bg, i) * (1 - alpha)).toString(16).padStart(2, '0'))
    .join('');
}

const css = readFileSync(path.resolve(__dirname, '../app/globals.css'), 'utf8');
const rootBlock = css.slice(css.indexOf(':root {'), css.indexOf('}', css.indexOf(':root {')));
function token(name: string): string {
  const m = rootBlock.match(new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`));
  if (!m) throw new Error(`token --${name} not found`);
  return m[1].toLowerCase();
}

describe('theme tokens meet WCAG AA', () => {
  const surfaces = ['bg', 'bg-card', 'bg-card-hover', 'bg-track'];

  it.each(['fg', 'fg-secondary', 'fg-muted', 'fg-subtle', 'fg-dim'])(
    '--%s reaches 4.5:1 on every surface',
    (name) => {
      for (const s of surfaces) expect(contrast(token(name), token(s))).toBeGreaterThanOrEqual(4.5);
    },
  );

  it('page-type colours reach 4.5:1 on the page and on their own 10% badge tint', () => {
    for (const hex of Object.values(PAGE_TYPE_HEX)) {
      const bg = token('bg');
      expect(contrast(hex, bg)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex, over(hex, bg, 0.1))).toBeGreaterThanOrEqual(4.5);
      expect(contrast(hex, token('bg-card'))).toBeGreaterThanOrEqual(4.5);
    }
  });

  it('the canvas palette mirrors the CSS page-type variables', () => {
    expect(PAGE_TYPE_HEX.concept).toBe(token('page-concept'));
    expect(PAGE_TYPE_HEX.entity).toBe(token('page-entity'));
    expect(PAGE_TYPE_HEX.comparison).toBe(token('page-comparison'));
    expect(PAGE_TYPE_HEX.overview).toBe(token('page-overview'));
  });

  it('the onboarding ghost labels use an accent strength that reaches 4.5:1 on cards', () => {
    expect(contrast(over(token('accent'), token('bg-card'), 0.55), token('bg-card'))).toBeGreaterThanOrEqual(4.5);
  });
});
