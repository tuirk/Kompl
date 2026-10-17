/**
 * Relation types outside the vocabulary are directional: the extractor
 * stores them in their natural order ("Ethereum founded_by Vitalik"), so
 * the two ends read differently ("Founded by" / "Founded", "Located in" /
 * "← Located in") and the two directions never merge. Only competes_with,
 * contradicts and related_to read the same both ways. The page card, the
 * graph's panels, its line labels and path steps (and MCP read_page, which
 * prints the card's labels) all read one vocabulary (relation-labels.ts).
 */

import { afterEach, describe, expect, it } from 'vitest';
import { linkSummary, readingOrder, relationsBetween } from '../lib/graph-focus';
import { lineStyle } from '../lib/graph-line-style';
import { buildGraphModel } from '../lib/graph-model';
import { pathSteps } from '../lib/graph-path';
import { isSymmetricRelation, relationLabel, SYMMETRIC_RELATIONS } from '../lib/relation-labels';
import { getPageConnections, getRelationEdges } from '../lib/relations';
import { getWikiGraph } from '../lib/wiki-graph';
import { seedPage, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function seed() {
  handle = setupTestDb();
  const db = handle.db;
  const [s1, s2] = ['One', 'Two'].map((title) => seedSource(db, { title }));
  for (const [id, title] of [['eth', 'Ethereum'], ['vb', 'Vitalik Buterin'], ['vilnius', 'Vilnius'], ['lt', 'Lithuania']]) {
    seedPage(db, { page_id: id, title });
  }
  const rel = db.prepare(
    'INSERT INTO relationship_mentions (from_canonical, to_canonical, relationship_type, source_id, description) VALUES (?, ?, ?, ?, ?)'
  );
  rel.run('Ethereum', 'Vitalik Buterin', 'founded_by', s1, 'Vitalik Buterin founded Ethereum.');
  rel.run('Vilnius', 'Lithuania', 'located_in', s1, 'Vilnius is in Lithuania.');
  rel.run('Lithuania', 'Vilnius', 'located_in', s2, 'A reversed row.');
}

describe('relation direction', () => {
  it('reads unknown types differently from each end; only three types are symmetric', () => {
    expect([...SYMMETRIC_RELATIONS].sort()).toEqual(['competes_with', 'contradicts', 'related_to']);
    for (const type of SYMMETRIC_RELATIONS) expect(relationLabel(type, 'in')).toBe(relationLabel(type, 'out'));
    expect(isSymmetricRelation('founded_by')).toBe(false);
    expect(isSymmetricRelation('part_of')).toBe(false);
    expect(relationLabel('founded_by', 'out')).toBe('Founded by');
    expect(relationLabel('founded_by', 'in')).toBe('Founded');
    expect(relationLabel('located_in', 'out')).toBe('Located in');
    expect(relationLabel('located_in', 'in')).toBe('← Located in');
    expect(relationLabel('by', 'in')).toBe('← By');
  });

  it('labels each end of an unknown type in the read model and keeps its two directions apart', () => {
    seed();
    expect(getPageConnections('eth').groups).toMatchObject([{ label: 'Founded by', items: [{ page_id: 'vb', direction: 'out' }] }]);
    expect(getPageConnections('vb').groups).toMatchObject([{ label: 'Founded', items: [{ page_id: 'eth', direction: 'in' }] }]);
    expect(getPageConnections('vilnius').groups).toMatchObject([
      { label: 'Located in', items: [{ page_id: 'lt', direction: 'out', source_count: 1 }] },
      { label: '← Located in', items: [{ page_id: 'lt', direction: 'in', source_count: 1 }] },
    ]);
    const edge = getRelationEdges().edges.find((e) => e.source === 'lt' && e.target === 'vilnius');
    expect(edge?.relations).toHaveLength(2);
  });

  it('gives the card, the graph panels, line labels and path steps the same reading', () => {
    seed();
    const model = buildGraphModel(getWikiGraph(false));
    const link = model.links.find((l) => l.a === 'eth' && l.b === 'vb')!;
    // The line reads forwards, from the stored `from` end.
    expect(readingOrder(link, 'vb')).toEqual(['eth', 'vb']);
    expect(lineStyle(link).label).toBe('founded by');
    expect(linkSummary(link, model.byId)).toBe('Ethereum — Founded by → Vitalik Buterin');
    // Read from the founder: the card, NodePanel/EdgePanel (relationsBetween) and a path step agree.
    const card = getPageConnections('vb').groups.map((g) => g.label);
    expect(relationsBetween(getPageConnections('vb'), 'eth').map((r) => r.label)).toEqual(card);
    expect(pathSteps({ nodes: ['vb', 'eth'], links: [link], cost: 1 })[0].label).toBe(card[0]);
  });
});
