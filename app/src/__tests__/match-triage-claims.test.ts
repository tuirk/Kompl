/**
 * Match triage is judged on cited claims (plan 3.5): the triage call carries
 * the claims the source's extraction makes about the page's subject, with
 * the source's own sentence when kept, plus the page's related section. A
 * source whose extraction makes no such claim is judged on its text. Stored
 * failures re-checked by a later compile are judged the same way.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as matchPOST } from '../app/api/compile/match/route';
import { setTriageRecheckEnabled } from '../lib/triage-rechecks';
import { setupTestDb, seedSource, seedExtraction, seedPage, type TestDbHandle } from './helpers/test-db';
import { seedStoredPair, stubFetch, verdict } from './helpers/triage-stub';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

const SESSION = 'sess-claims';
const PAGE_TEXT = [
  '---',
  'title: GPT-4',
  '---',
  '# GPT-4',
  'GPT-4 is a model by OpenAI.',
  '',
  '## Context window',
  'GPT-4 accepts a context window of 128k tokens.',
  '',
  '## Pricing',
  'Pricing is per million tokens.',
].join('\n');

const CLAIMS = {
  entities: [{ name: 'GPT-4', type: 'PRODUCT', mentions: [], context: 'a model' }],
  concepts: [],
  relationships: [],
  claims: [
    { claim: 'GPT-4 has a 32k context window.', confidence: 'stated', entities_involved: ['GPT-4'], quote: 'GPT-4 supports 32,768 tokens.' },
    { claim: 'Claude is made by Anthropic.', confidence: 'stated', entities_involved: ['Claude'] },
  ],
};

function seedGpt4Page(): string {
  const page_id = seedPage(handle!.db, { page_id: 'p-gpt4', title: 'GPT-4', page_type: 'entity', summary: 'A model.' });
  handle!.db.prepare('UPDATE pages SET pending_content = ? WHERE page_id = ?').run(PAGE_TEXT, page_id);
  return page_id;
}

async function runMatch(): Promise<void> {
  const res = await matchPOST(
    new Request('http://test/api/compile/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: SESSION, canonical_entities: [] }),
    }),
  );
  expect(res.status).toBe(200);
}

describe('match triage evidence', () => {
  it("sends the source's claims about the page with their sentences, and the page's related section", async () => {
    handle = setupTestDb();
    seedGpt4Page();
    const source_id = seedSource(handle.db, {
      onboarding_session_id: SESSION,
      compile_status: 'extracted',
      raw_markdown: `alpha RAW SOURCE TEXT ${'x'.repeat(600)}`,
    });
    seedExtraction(handle.db, { source_id, llm_output: CLAIMS });
    const stub = stubFetch({ candidates: { alpha: ['p-gpt4'] }, triage: { 'GPT-4': verdict('skip') } });

    await runMatch();

    expect(stub.triageBodies).toHaveLength(1);
    const body = stub.triageBodies[0];
    expect(body.evidence).toBe('claims');
    expect(body.source_claims).toBe('- GPT-4 has a 32k context window.\n  Source sentence: "GPT-4 supports 32,768 tokens."');
    expect(body.page_section).toContain('128k tokens');
    expect(body.page_section).not.toContain('Pricing');
    expect(body.existing_page_summary).toBe('A model.');
    expect(JSON.stringify(body)).not.toContain('RAW SOURCE TEXT');
  });

  it('falls back to the source text when the extraction makes no claim about the page', async () => {
    handle = setupTestDb();
    seedGpt4Page();
    const source_id = seedSource(handle.db, {
      onboarding_session_id: SESSION,
      compile_status: 'extracted',
      raw_markdown: `alpha RAW SOURCE TEXT ${'x'.repeat(600)}`,
    });
    seedExtraction(handle.db, { source_id, llm_output: { entities: [], concepts: [], relationships: [] } });
    const stub = stubFetch({ candidates: { alpha: ['p-gpt4'] }, triage: { 'GPT-4': verdict('skip') } });

    await runMatch();

    expect(stub.triageBodies).toHaveLength(1);
    expect(stub.triageBodies[0]).toMatchObject({ evidence: 'source_text', page_section: '' });
    expect(stub.triageBodies[0].source_claims).toContain('RAW SOURCE TEXT');
  });

  it('judges a re-checked stored pair on its claims too', async () => {
    handle = setupTestDb();
    setTriageRecheckEnabled(true);
    const page_id = seedGpt4Page();
    const earlier = seedSource(handle.db, {
      onboarding_session_id: 'sess-earlier',
      compile_status: 'active',
      raw_markdown: `gamma EARLIER TEXT ${'z'.repeat(600)}`,
    });
    seedExtraction(handle.db, { source_id: earlier, llm_output: CLAIMS });
    seedStoredPair(handle.db, { source_id: earlier, page_id });
    // This session's source names nothing and matches nothing.
    seedSource(handle.db, { onboarding_session_id: SESSION, compile_status: 'extracted', raw_markdown: `delta ${'d'.repeat(600)}` });
    const stub = stubFetch({ triage: { 'GPT-4': verdict('update') } });

    await runMatch();

    expect(stub.triageBodies).toHaveLength(1);
    expect(stub.triageBodies[0]).toMatchObject({ evidence: 'claims' });
    expect(stub.triageBodies[0].source_claims).toContain('32k context window');
    expect(stub.triageBodies[0].page_section).toContain('128k tokens');
  });
});
