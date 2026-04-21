/**
 * Comparison-page dossier filter — compile/draft/route.ts:buildDossier.
 *
 * The comparison branch must only surface relationships whose {from_entity, to}
 * pair matches the plan's two subjects. Without this scoping, a source
 * mentioning both "React vs Vue" and "Python vs JS" as `competes_with` would
 * pollute the dossier for the "React vs Vue" page with the Python/JS context.
 *
 * Ground truth for the pair comes from `related_plan_ids` (written by the
 * planner at plan/route.ts:340-352) resolved through a plan_id → title map.
 */

import { describe, it, expect } from 'vitest';
import { buildDossier } from '../app/api/compile/draft/route';

type Plan = {
  page_type: string;
  title: string;
  source_ids: string;
  related_plan_ids: string | null;
};

function mkExtraction(relationships: Array<{ from_entity: string; to: string; type: string; description?: string }>): Record<string, unknown> {
  return { entities: [], concepts: [], claims: [], contradictions: [], relationships };
}

describe('buildDossier — comparison filter', () => {
  it('includes only the relationship whose pair matches the plan subjects', () => {
    const plan: Plan = {
      page_type: 'comparison',
      title: 'React vs Vue',
      source_ids: JSON.stringify(['s1']),
      related_plan_ids: JSON.stringify(['plan-react', 'plan-vue']),
    };
    const extractions = new Map<string, Record<string, unknown>>([
      ['s1', mkExtraction([
        { from_entity: 'React', to: 'Vue', type: 'competes_with', description: 'frontend rivals' },
        { from_entity: 'Python', to: 'JavaScript', type: 'competes_with', description: 'irrelevant' },
      ])],
    ]);
    const titleMap = new Map([['plan-react', 'React'], ['plan-vue', 'Vue']]);

    const dossier = buildDossier(plan, extractions, titleMap);

    expect(dossier).toContain('React vs Vue');
    expect(dossier).toContain('frontend rivals');
    expect(dossier).not.toContain('Python');
    expect(dossier).not.toContain('JavaScript');
    expect(dossier).not.toContain('irrelevant');
  });

  it('falls back to type-only filter when related_plan_ids is null', () => {
    const plan: Plan = {
      page_type: 'comparison',
      title: 'React vs Vue',
      source_ids: JSON.stringify(['s1']),
      related_plan_ids: null,
    };
    const extractions = new Map<string, Record<string, unknown>>([
      ['s1', mkExtraction([
        { from_entity: 'React', to: 'Vue', type: 'competes_with', description: 'frontend rivals' },
        { from_entity: 'Python', to: 'JavaScript', type: 'competes_with', description: 'also included on fallback' },
      ])],
    ]);

    const dossier = buildDossier(plan, extractions, new Map());

    // Graceful degradation: current (pre-scoping) behaviour is the fallback —
    // both comparison relationships surface.
    expect(dossier).toContain('React vs Vue');
    expect(dossier).toContain('Python vs JavaScript');
  });

  it('falls back when related_plan_ids references a plan missing from the title map', () => {
    const plan: Plan = {
      page_type: 'comparison',
      title: 'React vs Vue',
      source_ids: JSON.stringify(['s1']),
      related_plan_ids: JSON.stringify(['plan-react', 'plan-missing']),
    };
    const extractions = new Map<string, Record<string, unknown>>([
      ['s1', mkExtraction([
        { from_entity: 'React', to: 'Vue', type: 'competes_with' },
        { from_entity: 'Python', to: 'JavaScript', type: 'competes_with' },
      ])],
    ]);
    const titleMap = new Map([['plan-react', 'React']]); // plan-missing absent

    const dossier = buildDossier(plan, extractions, titleMap);

    // Can't resolve both subjects → fall back; both surface.
    expect(dossier).toContain('React vs Vue');
    expect(dossier).toContain('Python vs JavaScript');
  });

  it('matches case-insensitively when extraction casing differs from plan title casing', () => {
    const plan: Plan = {
      page_type: 'comparison',
      title: 'React vs Vue',
      source_ids: JSON.stringify(['s1']),
      related_plan_ids: JSON.stringify(['plan-react', 'plan-vue']),
    };
    const extractions = new Map<string, Record<string, unknown>>([
      ['s1', mkExtraction([
        // LLM returned lowercase despite the canonical casing.
        { from_entity: 'react', to: 'VUE', type: 'competes_with', description: 'still matches' },
      ])],
    ]);
    const titleMap = new Map([['plan-react', 'React'], ['plan-vue', 'Vue']]);

    const dossier = buildDossier(plan, extractions, titleMap);

    expect(dossier).toContain('still matches');
  });

  it('matches the pair in reverse order (direction-agnostic)', () => {
    const plan: Plan = {
      page_type: 'comparison',
      title: 'React vs Vue',
      source_ids: JSON.stringify(['s1']),
      related_plan_ids: JSON.stringify(['plan-react', 'plan-vue']),
    };
    const extractions = new Map<string, Record<string, unknown>>([
      ['s1', mkExtraction([
        // Source names them in the opposite order — must still match.
        { from_entity: 'Vue', to: 'React', type: 'competes_with', description: 'reverse order' },
      ])],
    ]);
    const titleMap = new Map([['plan-react', 'React'], ['plan-vue', 'Vue']]);

    const dossier = buildDossier(plan, extractions, titleMap);

    expect(dossier).toContain('reverse order');
  });

  it('rejects partial-pair overlap (one side matches, the other does not)', () => {
    const plan: Plan = {
      page_type: 'comparison',
      title: 'React vs Vue',
      source_ids: JSON.stringify(['s1']),
      related_plan_ids: JSON.stringify(['plan-react', 'plan-vue']),
    };
    const extractions = new Map<string, Record<string, unknown>>([
      ['s1', mkExtraction([
        // React is in the pair, but Svelte isn't — partial overlap must be rejected.
        { from_entity: 'React', to: 'Svelte', type: 'competes_with', description: 'partial overlap' },
      ])],
    ]);
    const titleMap = new Map([['plan-react', 'React'], ['plan-vue', 'Vue']]);

    const dossier = buildDossier(plan, extractions, titleMap);

    expect(dossier).not.toContain('partial overlap');
  });

  it('handles malformed related_plan_ids JSON without throwing', () => {
    const plan: Plan = {
      page_type: 'comparison',
      title: 'React vs Vue',
      source_ids: JSON.stringify(['s1']),
      related_plan_ids: '{not valid json',
    };
    const extractions = new Map<string, Record<string, unknown>>([
      ['s1', mkExtraction([
        { from_entity: 'React', to: 'Vue', type: 'competes_with', description: 'still renders' },
      ])],
    ]);

    expect(() => buildDossier(plan, extractions, new Map())).not.toThrow();
    const dossier = buildDossier(plan, extractions, new Map());
    expect(dossier).toContain('still renders');
  });
});
