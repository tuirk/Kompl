/**
 * Disputes a page records in its own text (lib/page-disputes.ts): which
 * sections count (two or more sources cited), their topic, anchor and
 * position, and how the activity feed shows a recorded one (the record
 * itself: disagreements.test.ts).
 */

import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { getEventDef, resolveBadge, type FeedActivityRow } from '../lib/activity-events';
import { findPageDisputes } from '../lib/page-disputes';

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

  it('tells Disputed from Changed (plan 3.1)', () => {
    const page = [
      '## History',
      '',
      '### Disputed: launch year',
      '',
      `2013[^${A}] or 2015[^${B}].`,
      '',
      '### Changed: block size limit',
      '',
      `It was 1 MB as of 2015[^${A}]; it is 4 MB as of 2021[^${C}].`,
    ].join('\n');
    expect(findPageDisputes(page).map((d) => [d.kind, d.topic, d.sourceIds])).toEqual([
      ['disputed', 'Launch year', [A, B]],
      ['changed', 'Block size limit', [A, C]],
    ]);
  });

  it('matches the keyword anywhere in a heading, at any level, in any case', () => {
    const cite = `One says 1[^${A}], another 2[^${B}].`;
    const found = (heading: string) => findPageDisputes(`## Intro\n\nText.\n\n${heading}\n\n${cite}`);
    const read = (heading: string) => found(heading).map((d) => [d.kind, d.topic]);
    expect(read('# Founding date (disputed)')).toEqual([['disputed', 'Founding date']]);
    expect(read('#### Population — CHANGED')).toEqual([['changed', 'Population']]);
    expect(read('##### Why historians disagree')).toEqual([['disputed', 'Why historians disagree']]);
    expect(read('###### Disputed founding place')).toEqual([['disputed', 'Founding place']]);
    expect(read('## Disputes over the river name')).toEqual([['disputed', 'The river name']]);
    // Nothing but the keyword and filler: the first sentence names it.
    expect(read('### Contradictions between sources')).toEqual([['disputed', 'One says 1, another 2.']]);
    expect(read('## Undisputed facts')).toEqual([]);
    // "Changed" counts only as the heading's lead or tail, not mid-sentence.
    expect(read('### Changed — consensus method')).toEqual([['changed', 'Consensus method']]);
    expect(read('### What changed in 2024')).toEqual([]);
    expect(read('## How the rules changed over time')).toEqual([]);
    // Only ## and ### headings have a place in the table of contents.
    expect(found('#### Population — changed')[0].headingIndex).toBe(-1);
    expect(found('### Population — changed')[0].headingIndex).toBe(1);
  });

  it('a section holding Disputed/Changed sub-sections is not a dispute of its own', () => {
    const page = [
      '## Contradictions',
      '',
      `Sources differ[^${A}][^${B}].`,
      '',
      '### Disputed: launch year',
      '',
      `2013[^${A}] or 2015[^${B}].`,
      '',
      '### Changed: the limit',
      '',
      `10[^${A}], now 20[^${C}].`,
    ].join('\n');
    expect(findPageDisputes(page).map((d) => d.topic)).toEqual(['Launch year', 'The limit']);
  });

  it('a heading that only mentions a change elsewhere is not read as one', () => {
    expect(findPageDisputes(`## Changes in 2024\n\nA[^${A}] B[^${B}].`)).toEqual([]);
    expect(findPageDisputes(`## Exchange rates\n\nA[^${A}] B[^${B}].`)).toEqual([]);
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
