/**
 * buildDossier when a source names the page's subject as the other kind.
 *
 * An update keeps the page's type (plan/route.ts updatePageType), so an
 * entity page can be fed by a source whose extraction lists the name as a
 * concept, and the reverse. buildDossier looked only in the list matching the
 * page type, so the source's definition and context were lost, and its
 * matching claims came out without the "From source X:" header that
 * capDossierByRelevance needs to rank and attribute a block.
 */

import { describe, it, expect } from 'vitest';
import { buildDossier } from '../app/api/compile/draft/route';

function dossierFor(page_type: 'entity' | 'concept', title: string, ext: Record<string, unknown>): string {
  return buildDossier(
    { page_type, title, source_ids: JSON.stringify(['src-A']), related_plan_ids: null },
    new Map([['src-A', { entities: [], concepts: [], claims: [], contradictions: [], relationships: [], ...ext }]]),
    new Map(),
    new Map()
  );
}

describe('buildDossier: subject listed under the other kind', () => {
  it('entity page, source lists the name as a concept: definition and claims kept under a source header', () => {
    const dossier = dossierFor('entity', 'APCA', {
      concepts: [{ name: 'APCA', description: 'A perceptual contrast algorithm', context: 'Used in WCAG 3 drafts' }],
      claims: [{ claim: 'APCA predicts readability better than WCAG 2 ratios' }],
    });

    expect(dossier).toBe(
      [
        'From source src-A:',
        '  Definition: A perceptual contrast algorithm',
        '  Context: Used in WCAG 3 drafts',
        '  Claim: APCA predicts readability better than WCAG 2 ratios',
      ].join('\n')
    );
  });

  it('concept page, source lists the name as an entity: type and context kept under a source header', () => {
    const dossier = dossierFor('concept', 'Proof of Stake', {
      entities: [{ name: 'Proof of Stake', type: 'TECHNOLOGY', mentions: 3, context: 'Ethereum moved to it' }],
    });

    expect(dossier).toBe(
      ['From source src-A:', '  Type: TECHNOLOGY', '  Mentions: 3', '  Context: Ethereum moved to it'].join('\n')
    );
  });

  it("the page's own kind wins when a source lists the name as both", () => {
    const dossier = dossierFor('entity', 'APCA', {
      entities: [{ name: 'APCA', type: 'STANDARD', context: 'entity context' }],
      concepts: [{ name: 'APCA', description: 'concept definition' }],
    });

    expect(dossier).toContain('Type: STANDARD');
    expect(dossier).not.toContain('concept definition');
  });

  it('a block with only matching claims still starts with its source header', () => {
    const dossier = dossierFor('entity', 'APCA', {
      claims: [{ claim: 'APCA is not yet a W3C recommendation' }],
    });

    expect(dossier).toBe('From source src-A:\n  Claim: APCA is not yet a W3C recommendation');
  });

  it('a source that never mentions the subject adds nothing', () => {
    expect(dossierFor('concept', 'APCA', { claims: [{ claim: 'Unrelated claim' }] })).toBe('');
  });
});
