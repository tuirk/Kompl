/**
 * Island names that would print over each other
 * (app/wiki/graph/graph-islands.ts hideOverlappingNames): the island with
 * more pages keeps its name, the other is left out.
 */

import { describe, expect, it } from 'vitest';
import { hideOverlappingNames } from '../app/wiki/graph/graph-islands';

function run(count: number[], left: number[], right: number[], top: number[], bottom: number[]) {
  const hidden = new Uint8Array(count.length);
  hideOverlappingNames(count, left, right, top, bottom, hidden, []);
  return Array.from(hidden);
}

describe('hideOverlappingNames', () => {
  it('keeps the larger island and hides the smaller one it covers', () => {
    expect(run([1, 5], [0, 5], [10, 15], [0, 0], [10, 10])).toEqual([1, 0]);
  });

  it('keeps both when the boxes only touch or are apart', () => {
    expect(run([3, 3], [0, 10], [10, 20], [0, 0], [10, 10])).toEqual([0, 0]);
    expect(run([3, 3], [0, 0], [10, 10], [0, 20], [10, 30])).toEqual([0, 0]);
  });

  it('does not let a hidden name hide a third one', () => {
    // 0 covers 1, 1 would cover 2, but 0 does not reach 2.
    expect(run([9, 5, 1], [0, 8, 16], [10, 18, 26], [0, 0, 0], [10, 10, 10])).toEqual([0, 1, 0]);
  });

  it('breaks ties by position and ignores empty islands', () => {
    expect(run([2, 2, 0], [0, 5, 0], [10, 15, 100], [0, 0, 0], [10, 10, 10])).toEqual([0, 1, 0]);
  });
});
