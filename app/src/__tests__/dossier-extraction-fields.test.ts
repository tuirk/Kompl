/**
 * The draft dossier reads the fields the extractor actually writes
 * (nlp-service/services/llm_client.py): contradictions are { claim, against }
 * and concepts are { name, description }. buildDossier used to read
 * contradiction `description` and concept `definition`, which never exist, so
 * every extracted contradiction and concept definition was dropped before the
 * drafting model saw it. The contradiction lines must also say which side is
 * the source's own: the drafter treats the dossier as its primary reference.
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { POST as draftPOST, buildDossier } from '../app/api/compile/draft/route';
import { seedCompileProgress, seedExtraction, seedPagePlan, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

function plan(page_type: string, title: string, sourceIds: string[]) {
  return { page_type, title, source_ids: JSON.stringify(sourceIds), related_plan_ids: null };
}

describe('buildDossier — extraction contradictions', () => {
  it('keeps contradictions about the page and says which side the source takes', () => {
    const extractions = new Map<string, Record<string, unknown>>([
      [
        'src-A',
        {
          entities: [{ name: 'Lake Galve', type: 'LOCATION', mentions: 3, context: 'A lake near Trakai.' }],
          concepts: [],
          claims: [],
          relationships: [],
          contradictions: [
            { claim: 'Lake Galve is 30 metres deep at most.', against: 'Lake Galve reaches 46.5 metres.' },
            { claim: 'It is shallow everywhere.', against: 'Lake Galve is the deepest lake around Trakai.' },
            { claim: 'Lake Galve never freezes.', against: '' },
            { claim: 'Kaunas is the older city.', against: 'Vilnius is older.' },
          ],
        },
      ],
    ]);

    const dossier = buildDossier(plan('entity', 'Lake Galve', ['src-A']), extractions, new Map(), new Map());

    expect(dossier).toContain(
      '  This source disputes "Lake Galve reaches 46.5 metres." and says instead "Lake Galve is 30 metres deep at most."',
    );
    // Matched through the disputed view alone.
    expect(dossier).toContain(
      '  This source disputes "Lake Galve is the deepest lake around Trakai." and says instead "It is shallow everywhere."',
    );
    expect(dossier).toContain('  This source contradicts other accounts by saying "Lake Galve never freezes."');
    // About another subject: not this page's dossier.
    expect(dossier).not.toContain('Kaunas');
    expect(dossier).not.toContain('undefined');
  });

  it('gives concept pages their contradictions too (plan 3.1)', () => {
    const extractions = new Map<string, Record<string, unknown>>([
      [
        'src-A',
        {
          entities: [],
          concepts: [{ name: 'Proof of stake', description: 'A consensus method.' }],
          claims: [],
          relationships: [],
          contradictions: [
            { claim: 'Proof of stake uses 99% less energy.', against: 'Proof of stake saves little energy.' },
            { claim: 'Mining is profitable.', against: 'Mining is not profitable.' },
          ],
        },
      ],
    ]);

    const dossier = buildDossier(plan('concept', 'Proof of stake', ['src-A']), extractions, new Map(), new Map());

    expect(dossier).toContain(
      '  This source disputes "Proof of stake saves little energy." and says instead "Proof of stake uses 99% less energy."',
    );
    expect(dossier).not.toContain('Mining');
  });
});

describe('buildDossier — concept definitions', () => {
  it('reads description, and definition from older extraction rows', () => {
    const extractions = new Map<string, Record<string, unknown>>([
      [
        'src-A',
        {
          entities: [],
          concepts: [{ name: 'Cost-per-task', description: 'The cost of completing one task with an LLM.' }],
          claims: [],
          relationships: [],
          contradictions: [],
        },
      ],
      [
        'src-B',
        {
          entities: [],
          concepts: [{ name: 'Cost-per-task', definition: 'An older row with a definition field.' }],
          claims: [],
          relationships: [],
          contradictions: [],
        },
      ],
    ]);

    const dossier = buildDossier(plan('concept', 'Cost-per-task', ['src-A', 'src-B']), extractions, new Map(), new Map());

    expect(dossier).toContain('  Definition: The cost of completing one task with an LLM.');
    expect(dossier).toContain('  Definition: An older row with a definition field.');
  });
});

describe('note pages', () => {
  it('fall back to the first concept description for their summary when no claim was extracted', async () => {
    handle = setupTestDb();
    const session = 'sess-note';
    seedCompileProgress(handle.db, session);
    const sid = seedSource(handle.db, {
      onboarding_session_id: session,
      raw_markdown: 'My notes on evaluation metrics.',
    });
    seedExtraction(handle.db, {
      source_id: sid,
      llm_output: {
        entities: [],
        concepts: [{ name: 'Cost-per-task', description: 'Cost of one completed task.' }],
        claims: [],
        relationships: [],
        contradictions: [],
      },
    });
    const planId = seedPagePlan(handle.db, {
      session_id: session,
      title: 'Evaluation notes',
      page_type: 'original-source',
      action: 'create',
      source_ids: [sid],
      draft_status: 'planned',
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response('not used', { status: 404 })));

    const res = await draftPOST(
      new Request('http://test/api/compile/draft', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: session }),
      }),
    );

    expect(res.status).toBe(200);
    const row = handle.db.prepare('SELECT draft_content FROM page_plans WHERE plan_id = ?').get(planId) as {
      draft_content: string;
    };
    expect(row.draft_content).toContain('summary: "Cost of one completed task."');
  });
});
