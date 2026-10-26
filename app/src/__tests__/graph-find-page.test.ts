/**
 * The keyboard's way into the knowledge graph: the canvas's accessible name
 * (lib/graph-scope.ts canvasLabel) and "Find a page" in the header
 * (app/wiki/graph/FindPage.tsx findPage), which picks a page by its title or
 * the start of one.
 */

import { describe, expect, it } from 'vitest';
import { findPage } from '../app/wiki/graph/FindPage';
import type { ModelNode } from '../lib/graph-model';
import { canvasLabel } from '../lib/graph-scope';

const node = (id: string, label: string, archived = false) => ({ id, label, archived }) as ModelNode;
// Sorted by title, as the field lists them.
const PAGES = [node('b1', 'Bitcoin'), node('b2', 'Bitcoin network'), node('e', 'Ethereum'), node('o', 'Old wallet', true)];

describe('find a page', () => {
  it('picks the page whose title the text is, in any case', () => {
    expect(findPage(PAGES, 'bitcoin network', false)).toBe('b2');
    expect(findPage(PAGES, '  Ethereum ', false)).toBe('e');
    expect(findPage(PAGES, 'Old wallet (archived)', false)).toBe('o');
  });

  it('picks nothing for part of a title, unless asked to take the first title it starts', () => {
    expect(findPage(PAGES, 'Bitc', false)).toBeNull();
    expect(findPage(PAGES, 'bitcoin n', true)).toBe('b2');
    expect(findPage(PAGES, 'eth', true)).toBe('e');
    // An exact title wins over a longer one that starts with it.
    expect(findPage(PAGES, 'Bitcoin', true)).toBe('b1');
    expect(findPage(PAGES, 'zcash', true)).toBeNull();
    expect(findPage(PAGES, '   ', true)).toBeNull();
  });
});

describe('canvas name', () => {
  it('says what the map shows and how to reach a page by keyboard', () => {
    expect(canvasLabel(12, 30, null)).toBe(
      'Knowledge graph: 12 pages and 30 connections. Use “Find a page” to open a page and its connections by keyboard.'
    );
    expect(canvasLabel(1, 1, 'Bitcoin')).toBe(
      'Knowledge graph focused on Bitcoin: 1 page and 1 connection. Use “Find a page” to open a page and its connections by keyboard.'
    );
  });
});
