/**
 * Disputes a page records in its own text (lib/page-disputes.ts): which
 * sections count (two or more sources cited), their topic, anchor and
 * position, and the activity event the commit paths log for each new one,
 * once.
 */

import type { ReactElement } from 'react';
import { afterEach, describe, expect, it } from 'vitest';
import { getEventDef, resolveBadge, type FeedActivityRow } from '../lib/activity-events';
import { findPageDisputes, recordNewDisputes } from '../lib/page-disputes';
import { getActivityCounts, setupTestDb, type TestDbHandle } from './helpers/test-db';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';

const PAGE = [
  '---',
  'title: Vilnius',
  'summary: Capital of Lithuania.',
  '---',
  '',
  `Vilnius is the capital of [[Lithuania]][^${A}].`,
  '',
  '## Disputed: whether Vilnius is a well-known tourist destination',
  '',
  `One account says it is largely unknown[^${B}]. Another calls it one of the most popular destinations in Europe[^${A}].`,
  '',
  '### Why the accounts differ',
  '',
  `The campaign was marketing[^${C}].`,
  '',
  '## Landmarks',
  '',
  `The cathedral[^${A}].`,
  '',
  '## Contradictions',
  '',
  `- The founding year is given as 1323[^${A}] and as 1320[^${C}]. Both cite chronicles.`,
  '',
  '## Disputed: the old town size',
  '',
  `Only one source covers it[^${B}].`,
  '',
  '```',
  `## Disputed: inside a code block[^${A}][^${B}]`,
  '```',
].join('\n');

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text((node as ReactElement<{ children?: unknown }>).props.children);
}

describe('findPageDisputes', () => {
  it('reads dispute sections that cite two or more sources, sub-sections included', () => {
    const disputes = findPageDisputes(PAGE);
    expect(disputes.map((d) => d.topic)).toEqual([
      'Whether Vilnius is a well-known tourist destination',
      'The founding year is given as 1323 and as 1320.',
    ]);
    expect(disputes[0].sourceIds).toEqual([B, A, C]); // order of first citation
    expect(disputes[0].anchor).toBe('disputed-whether-vilnius-is-a-well-known-tourist-destination');
    expect(disputes[1].sourceIds).toEqual([A, C]);
    // Positions among the page's ## and ### headings (code blocks don't count).
    expect(disputes.map((d) => d.headingIndex)).toEqual([0, 3]);
  });

  it('finds nothing on a page without dispute sections', () => {
    expect(findPageDisputes(`---\ntitle: X\n---\n\n## Overview\n\nText[^${A}][^${B}].`)).toEqual([]);
  });
});

describe('recordNewDisputes', () => {
  it('logs each new dispute once; rewording it with the same sources is not new', () => {
    handle = setupTestDb();
    const page = { page_id: 'vilnius', title: 'Vilnius' };

    expect(recordNewDisputes(page, PAGE)).toBe(2);
    expect(recordNewDisputes(page, PAGE)).toBe(0);
    const reworded = PAGE.replace('whether Vilnius is a well-known tourist destination', 'how famous Vilnius is');
    expect(recordNewDisputes(page, reworded)).toBe(0);
    expect(getActivityCounts(handle.db).page_dispute_recorded).toBe(2);

    const more = `${PAGE}\n\n## Disputed: the population\n\nAbout 580,000[^${B}], about 600,000[^${C}].`;
    expect(recordNewDisputes(page, more)).toBe(1);
    expect(getActivityCounts(handle.db).page_dispute_recorded).toBe(3);
  });
});

describe('page_dispute_recorded in the activity feed', () => {
  it('links to the disputed section and says how many sources disagree', () => {
    const def = getEventDef('page_dispute_recorded')!;
    const row: FeedActivityRow = {
      id: 1,
      timestamp: '2026-10-10 10:00:00',
      action_type: 'page_dispute_recorded',
      source_id: null,
      source_title: null,
      details: JSON.stringify({
        page_id: 'vilnius',
        title: 'Vilnius',
        topic: 'Whether Vilnius is well known',
        anchor: 'disputed-whether-vilnius-is-well-known',
        source_ids: [A, B, C],
      }),
    };
    expect(resolveBadge(def, row)).toEqual({ label: 'DISPUTE', tone: 'red' });
    const content = def.render(row);
    expect(text(content.primary)).toBe('Vilnius');
    expect((content.primary as ReactElement<{ href: string }>).props.href).toBe(
      '/wiki/vilnius#disputed-whether-vilnius-is-well-known',
    );
    expect(text(content.secondary)).toBe('disputed: Whether Vilnius is well known · 3 sources disagree');
  });
});
