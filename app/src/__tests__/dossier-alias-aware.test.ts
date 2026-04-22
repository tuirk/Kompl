/**
 * Alias-aware buildDossier — compile/draft/route.ts.
 *
 * Before this fix, buildDossier filtered extractions by exact match of raw
 * entity/concept name against plan.title (the canonical). Because
 * extractions.llm_output is never rewritten after resolve, any source whose
 * LLM emitted a pre-canonical spelling (e.g. "GPT 4" when the canonical is
 * "GPT-4") was silently dropped from the dossier — its mentions, claims,
 * and relationships never reached the drafting LLM.
 *
 * Fix: pass a canonical→Set<alias> map built from the aliases table. The
 * filter tests rawName ∈ aliasSet instead of rawName === canonical.
 * Substring filters iterate the set, with a 3-char minimum to block
 * false positives from short aliases like "AI" or "ML".
 */

import { describe, it, expect } from 'vitest';
import { buildDossier } from '../app/api/compile/draft/route';

type Plan = {
  page_type: string;
  title: string;
  source_ids: string;
  related_plan_ids: string | null;
};

function entityExtraction(args: {
  name: string;
  mentions?: number;
  context?: string;
  claims?: string[];
  rels?: Array<{ from_entity: string; to: string; type: string; description?: string }>;
}): Record<string, unknown> {
  return {
    entities: [
      {
        name: args.name,
        type: 'PRODUCT',
        mentions: args.mentions ?? 1,
        context: args.context ?? `Context for ${args.name}`,
      },
    ],
    concepts: [],
    claims: (args.claims ?? []).map((c) => ({ claim: c })),
    contradictions: [],
    relationships: args.rels ?? [],
  };
}

function conceptExtraction(args: {
  name: string;
  definition?: string;
  claims?: string[];
}): Record<string, unknown> {
  return {
    entities: [],
    concepts: [{ name: args.name, definition: args.definition ?? `Def for ${args.name}` }],
    claims: (args.claims ?? []).map((c) => ({ claim: c })),
    contradictions: [],
    relationships: [],
  };
}

describe('buildDossier — alias awareness', () => {
  it('ENTITY: mixed-spelling extractions with alias row → both blocks present', () => {
    const plan: Plan = {
      page_type: 'entity',
      title: 'GPT-4',
      source_ids: JSON.stringify(['src-A', 'src-B']),
      related_plan_ids: null,
    };
    const extractions = new Map<string, Record<string, unknown>>([
      ['src-A', entityExtraction({ name: 'GPT 4', context: 'A calls it GPT 4' })],
      ['src-B', entityExtraction({ name: 'GPT-4', context: 'B uses canonical' })],
    ]);
    const aliases = new Map<string, Set<string>>([
      ['gpt-4', new Set(['gpt-4', 'gpt 4', 'gpt4'])],
    ]);

    const dossier = buildDossier(plan, extractions, new Map(), aliases);

    expect(dossier).toContain('From source src-A');
    expect(dossier).toContain('From source src-B');
    expect(dossier).toContain('A calls it GPT 4');
    expect(dossier).toContain('B uses canonical');
  });

  it('CONCEPT: alias rescues a source the exact-match filter would miss', () => {
    const plan: Plan = {
      page_type: 'concept',
      title: 'Chinchilla Scaling Law',
      source_ids: JSON.stringify(['src-A', 'src-B']),
      related_plan_ids: null,
    };
    const extractions = new Map<string, Record<string, unknown>>([
      [
        'src-A',
        conceptExtraction({
          name: 'Chinchilla scaling',
          definition: 'DeepMind compute-optimal law',
        }),
      ],
      [
        'src-B',
        conceptExtraction({
          name: 'Chinchilla Scaling Law',
          definition: 'Canonical long form',
        }),
      ],
    ]);
    const aliases = new Map<string, Set<string>>([
      [
        'chinchilla scaling law',
        new Set(['chinchilla scaling law', 'chinchilla scaling']),
      ],
    ]);

    const dossier = buildDossier(plan, extractions, new Map(), aliases);

    expect(dossier).toContain('From source src-A');
    expect(dossier).toContain('From source src-B');
    expect(dossier).toContain('DeepMind compute-optimal law');
    expect(dossier).toContain('Canonical long form');
  });

  it('ENTITY claims: substring path picks up an aliased spelling', () => {
    const plan: Plan = {
      page_type: 'entity',
      title: 'GPT-4',
      source_ids: JSON.stringify(['src-A']),
      related_plan_ids: null,
    };
    // Source only carries claim text with the aliased spelling.
    const ext: Record<string, unknown> = {
      entities: [{ name: 'GPT 4', type: 'PRODUCT', mentions: 1, context: 'c' }],
      concepts: [],
      claims: [{ claim: 'GPT 4 leads coding benchmarks' }],
      contradictions: [],
      relationships: [],
    };
    const extractions = new Map<string, Record<string, unknown>>([['src-A', ext]]);
    const aliases = new Map<string, Set<string>>([
      ['gpt-4', new Set(['gpt-4', 'gpt 4'])],
    ]);

    const dossier = buildDossier(plan, extractions, new Map(), aliases);

    expect(dossier).toContain('GPT 4 leads coding benchmarks');
  });

  it('COMPARISON: mixed-spelling endpoints survive the OR-of-AND filter', () => {
    const plan: Plan = {
      page_type: 'comparison',
      title: 'Claude vs GPT-4',
      source_ids: JSON.stringify(['src-A']),
      related_plan_ids: JSON.stringify(['plan-claude', 'plan-gpt']),
    };
    const ext: Record<string, unknown> = {
      entities: [],
      concepts: [],
      claims: [],
      contradictions: [],
      relationships: [
        {
          from_entity: 'Claude',
          to: 'GPT 4',
          type: 'competes_with',
          description: 'A rivalry under raw spelling',
        },
      ],
    };
    const extractions = new Map<string, Record<string, unknown>>([['src-A', ext]]);
    const titleMap = new Map([
      ['plan-claude', 'Claude'],
      ['plan-gpt', 'GPT-4'],
    ]);
    const aliases = new Map<string, Set<string>>([
      ['gpt-4', new Set(['gpt-4', 'gpt 4'])],
      ['claude', new Set(['claude'])],
    ]);

    const dossier = buildDossier(plan, extractions, titleMap, aliases);

    expect(dossier).toContain('Claude vs GPT 4');
    expect(dossier).toContain('A rivalry under raw spelling');
  });

  it('COMPARISON symmetry: both-endpoints-alias-to-same-subject must NOT match', () => {
    // Regression guard for the review BLOCKER: a relationship whose BOTH
    // endpoints alias to GPT-4 (not Claude) must not sneak into a
    // "Claude vs GPT-4" dossier under a naive union-based filter.
    const plan: Plan = {
      page_type: 'comparison',
      title: 'Claude vs GPT-4',
      source_ids: JSON.stringify(['src-A']),
      related_plan_ids: JSON.stringify(['plan-claude', 'plan-gpt']),
    };
    const ext: Record<string, unknown> = {
      entities: [],
      concepts: [],
      claims: [],
      contradictions: [],
      relationships: [
        {
          from_entity: 'GPT-4',
          to: 'GPT 4',
          type: 'competes_with',
          description: 'fake self-rivalry',
        },
      ],
    };
    const extractions = new Map<string, Record<string, unknown>>([['src-A', ext]]);
    const titleMap = new Map([
      ['plan-claude', 'Claude'],
      ['plan-gpt', 'GPT-4'],
    ]);
    const aliases = new Map<string, Set<string>>([
      ['gpt-4', new Set(['gpt-4', 'gpt 4'])],
      ['claude', new Set(['claude'])],
    ]);

    const dossier = buildDossier(plan, extractions, titleMap, aliases);

    expect(dossier).not.toContain('fake self-rivalry');
    expect(dossier.trim()).toBe('');
  });

  it('No regression: empty alias map falls back to canonical-only exact match', () => {
    const plan: Plan = {
      page_type: 'entity',
      title: 'Foo',
      source_ids: JSON.stringify(['src-A', 'src-B']),
      related_plan_ids: null,
    };
    const extractions = new Map<string, Record<string, unknown>>([
      ['src-A', entityExtraction({ name: 'Foo', context: 'exact match' })],
      ['src-B', entityExtraction({ name: 'Bar', context: 'different entity' })],
    ]);

    const dossier = buildDossier(plan, extractions, new Map(), new Map());

    expect(dossier).toContain('From source src-A');
    expect(dossier).toContain('exact match');
    expect(dossier).not.toContain('From source src-B');
    expect(dossier).not.toContain('different entity');
  });

  it('Substring false-positive guard: 2-char alias must NOT match unrelated claim', () => {
    // Regression guard for review MAJOR: "AI" as a 2-char alias would
    // otherwise substring-match "paid", "said", "trail". MIN_SUBSTRING_ALIAS_LEN=3
    // blocks this.
    const plan: Plan = {
      page_type: 'entity',
      title: 'AI',
      source_ids: JSON.stringify(['src-A']),
      related_plan_ids: null,
    };
    const ext: Record<string, unknown> = {
      entities: [{ name: 'AI', type: 'CONCEPT', mentions: 1, context: 'correct entity match' }],
      concepts: [],
      claims: [{ claim: 'the company was paid to deploy a model' }],
      contradictions: [],
      relationships: [],
    };
    const extractions = new Map<string, Record<string, unknown>>([['src-A', ext]]);
    const aliases = new Map<string, Set<string>>([['ai', new Set(['ai'])]]);

    const dossier = buildDossier(plan, extractions, new Map(), aliases);

    // Entity block still matches (exact-name path — not gated by length).
    expect(dossier).toContain('From source src-A');
    expect(dossier).toContain('correct entity match');
    // But the substring-path claim must be dropped — "paid" contains "ai"
    // as a raw substring, and we never want that to leak into the dossier.
    expect(dossier).not.toContain('paid to deploy');
  });
});
