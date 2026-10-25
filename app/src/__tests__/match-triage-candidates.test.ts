/**
 * Which pages match triages a session source against (plan 3.5).
 *
 * Pages whose subject the source names (its mention rows after resolve) come
 * first: entity and concept pages by title, comparison pages when both ends
 * are named. They rank by the source's claims about the subject, then by
 * TF-IDF similarity. TF-IDF matches above the threshold fill the slots left.
 * The per-source cap is unchanged, so a compile makes no more triage calls
 * than before.
 */

import { describe, it, expect, afterEach, vi } from 'vitest';
import { POST as matchPOST } from '../app/api/compile/match/route';
import { MAX_TRIAGE_CANDIDATES_PER_SOURCE } from '../lib/triage-candidates';
import { setupTestDb, seedSource, seedExtraction, seedPage, type TestDbHandle } from './helpers/test-db';
import { stubFetch, verdict } from './helpers/triage-stub';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
  vi.unstubAllGlobals();
});

const SESSION = 'sess-candidates';

const tfidf = (matches: Array<[string, number]>) => () =>
  Response.json({ overlap_score: 0.5, top_matches: matches.map(([page_id, similarity]) => ({ page_id, similarity })) });

const claim = (text: string, entity: string) => ({ claim: text, confidence: 'stated', entities_involved: [entity] });

/** A session source whose extraction names `entities` and makes `claims`. */
function source(entities: string[], claims: Array<ReturnType<typeof claim>> = []): string {
  const source_id = seedSource(handle!.db, {
    onboarding_session_id: SESSION,
    compile_status: 'extracted',
    raw_markdown: `alpha ${'x'.repeat(600)}`,
  });
  seedExtraction(handle!.db, {
    source_id,
    llm_output: {
      entities: entities.map((name) => ({ name, type: 'PRODUCT', mentions: [], context: '' })),
      concepts: [],
      relationships: [],
      claims,
    },
  });
  return source_id;
}

/** Page ids are slugs (db.ts assertSafeId). */
const id = (title: string) => `p-${title.toLowerCase().replace(/[^a-z0-9]+/g, '-')}`;

function pages(titles: string[], page_type = 'entity'): void {
  for (const title of titles) seedPage(handle!.db, { page_id: id(title), title, page_type });
}

const answerAll = (titles: string[]) => Object.fromEntries(titles.map((t) => [t, verdict('skip')]));

async function runMatch(): Promise<{ stats: Record<string, number> }> {
  const res = await matchPOST(
    new Request('http://test/api/compile/match', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: SESSION, canonical_entities: [] }),
    }),
  );
  expect(res.status).toBe(200);
  return (await res.json()) as { stats: Record<string, number> };
}

describe('triage candidates from shared entities', () => {
  it('triages a page whose subject the source names, though TF-IDF finds nothing', async () => {
    handle = setupTestDb();
    pages(['Ethereum', 'Bitcoin']);
    source(['Ethereum']);
    const stub = stubFetch({ triage: answerAll(['Ethereum']), answers: { '/extract/tfidf-overlap': tfidf([]) } });

    const { stats } = await runMatch();

    expect(stub.triaged).toEqual(['Ethereum']);
    expect(stats.candidates_found).toBe(1);
  });

  it('follows the resolved name, not the spelling the source used', async () => {
    handle = setupTestDb();
    pages(['Ethereum']);
    const source_id = source(['ETH']);
    // What resolve's mention rebuild leaves: ETH grouped under the page's title.
    handle.db.prepare("UPDATE entity_mentions SET canonical_name = 'Ethereum' WHERE source_id = ?").run(source_id);
    const stub = stubFetch({ triage: answerAll(['Ethereum']), answers: { '/extract/tfidf-overlap': tfidf([]) } });

    await runMatch();

    expect(stub.triaged).toEqual(['Ethereum']);
  });

  it('puts shared-entity pages before TF-IDF matches, within the per-source cap', async () => {
    handle = setupTestDb();
    pages(['Ethereum', 'Bitcoin', 'Solana', 'Cardano', 'Polkadot']);
    source(['Ethereum', 'Bitcoin']);
    const stub = stubFetch({
      triage: answerAll(['Ethereum', 'Bitcoin', 'Solana', 'Cardano']),
      answers: { '/extract/tfidf-overlap': tfidf([[id('Solana'), 0.6], [id('Cardano'), 0.5], [id('Polkadot'), 0.4]]) },
    });

    const { stats } = await runMatch();

    expect(MAX_TRIAGE_CANDIDATES_PER_SOURCE).toBe(3);
    expect(stub.triaged).toEqual(['Bitcoin', 'Ethereum', 'Solana']);
    expect(stats.candidates_found).toBe(MAX_TRIAGE_CANDIDATES_PER_SOURCE);
  });

  it('ranks shared-entity pages by claims about them, then by similarity', async () => {
    handle = setupTestDb();
    pages(['Ethereum', 'Bitcoin', 'Solana', 'Cardano']);
    source(
      ['Ethereum', 'Bitcoin', 'Solana', 'Cardano'],
      [claim('Bitcoin halves.', 'Bitcoin'), claim('Bitcoin is old.', 'Bitcoin'), claim('Solana is fast.', 'Solana')],
    );
    const stub = stubFetch({
      triage: answerAll(['Bitcoin', 'Solana', 'Cardano']),
      answers: { '/extract/tfidf-overlap': tfidf([[id('Cardano'), 0.3], [id('Ethereum'), 0.1]]) },
    });

    await runMatch();

    expect(stub.triaged).toEqual(['Bitcoin', 'Solana', 'Cardano']);
  });

  it('takes a comparison page when the source names both ends', async () => {
    handle = setupTestDb();
    pages(['Claude vs GPT-4', 'Bard vs GPT-4'], 'comparison');
    source(['Claude', 'GPT-4']);
    const stub = stubFetch({ triage: answerAll(['Claude vs GPT-4']), answers: { '/extract/tfidf-overlap': tfidf([]) } });

    await runMatch();

    expect(stub.triaged).toEqual(['Claude vs GPT-4']);
  });

  it('leaves TF-IDF matches at or under the threshold out', async () => {
    handle = setupTestDb();
    pages(['Solana', 'Cardano']);
    source([]);
    const stub = stubFetch({
      triage: answerAll(['Solana']),
      answers: { '/extract/tfidf-overlap': tfidf([[id('Solana'), 0.2], [id('Cardano'), 0.15]]) },
    });

    await runMatch();

    expect(stub.triaged).toEqual(['Solana']);
  });

  it('still triages the shared-entity pages when TF-IDF fails', async () => {
    handle = setupTestDb();
    pages(['Ethereum']);
    source(['Ethereum']);
    const stub = stubFetch({
      triage: answerAll(['Ethereum']),
      answers: { '/extract/tfidf-overlap': () => Response.json({ detail: 'boom' }, { status: 500 }) },
    });

    await runMatch();

    expect(stub.triaged).toEqual(['Ethereum']);
  });

  it('never makes more calls than the cap per source', async () => {
    handle = setupTestDb();
    const titles = ['A1', 'A2', 'A3', 'A4', 'A5', 'A6'];
    pages(titles);
    source(titles);
    source(titles);
    const stub = stubFetch({
      triage: answerAll(titles),
      answers: { '/extract/tfidf-overlap': tfidf(titles.map((t) => [id(t), 0.9])) },
    });

    await runMatch();

    expect(stub.triaged).toHaveLength(2 * MAX_TRIAGE_CANDIDATES_PER_SOURCE);
  });
});
