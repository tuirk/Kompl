/**
 * Which claim pairs the claim check judges (plan 3.3, D3): claims from
 * different sources that share a subject with a page, too-common subjects
 * dropped, the 3 most similar per claim, number/date mismatches first, and
 * pairs already judged left out (lib/claim-check/candidates.ts, claims.ts).
 */

import { afterEach, describe, expect, it } from 'vitest';

import { findCandidatePairs, numbersDiffer, numbersIn } from '../lib/claim-check/candidates';
import { claimKey, claimsOf, loadWikiClaims, pairKey, subjectPages, type WikiClaim } from '../lib/claim-check/claims';
import { PAIRS_PER_CLAIM } from '../lib/claim-check/limits';
import { seedExtraction, seedPage, seedSource, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

function claim(source_id: string, text: string, subjects: string[], quote: string | null = null): WikiClaim {
  return { key: claimKey(source_id, text), source_id, text, quote, subjects };
}

const pages = (...titles: string[]) =>
  new Map(titles.map((t, i) => [t.toLowerCase(), { page_id: `page-${i}` }]));

describe('claim keys', () => {
  it('fold whitespace and case, and depend on the source', () => {
    expect(claimKey('s1', 'Bitcoin  launched in 2009.')).toBe(claimKey('s1', 'bitcoin launched in 2009. '));
    expect(claimKey('s1', 'Bitcoin launched in 2009.')).not.toBe(claimKey('s2', 'Bitcoin launched in 2009.'));
  });

  it('name a pair the same way in either order', () => {
    expect(pairKey('b', 'a')).toBe('a|b');
    expect(pairKey('a', 'b')).toBe('a|b');
  });
});

describe('claimsOf', () => {
  it('maps the names a claim involves to canonical names and keeps only checked quotes', () => {
    const pin = (name: string) => ({ eth: 'Ethereum', 'ether': 'Ethereum' })[name.toLowerCase()] ?? name;
    const claims = claimsOf(
      's1',
      {
        claims: [
          { claim: 'ETH moved to proof of stake in 2022.', entities_involved: ['ETH', 'Ether', 'Proof of Stake'], quote: 'In 2022 ETH moved.', quote_verified: true },
          { claim: 'Ether is deflationary.', entities_involved: ['Ether'], quote: 'Made up.', quote_verified: false },
          { claim: 'ETH moved to proof of stake in 2022.', entities_involved: ['ETH'] },
          { claim: '', entities_involved: ['ETH'] },
          'not a claim',
        ],
      },
      pin,
    );
    expect(claims.map((c) => [c.text, c.subjects, c.quote])).toEqual([
      ['ETH moved to proof of stake in 2022.', ['Ethereum', 'Proof of Stake'], 'In 2022 ETH moved.'],
      ['Ether is deflationary.', ['Ethereum'], null],
    ]);
  });

  it('reads extractions without claims as none', () => {
    expect(claimsOf('s1', { entities: [] }, (n) => n)).toEqual([]);
    expect(claimsOf('s1', null, (n) => n)).toEqual([]);
  });
});

describe('loadWikiClaims', () => {
  it('reads compiled, not archived sources and pins names to page titles and aliases', () => {
    handle = setupTestDb();
    const { db } = handle;
    seedPage(db, { page_id: 'p-eth', title: 'Ethereum', page_type: 'entity' });
    db.prepare(`INSERT INTO aliases (alias, canonical_name) VALUES ('ETH', 'Ethereum')`).run();
    const llm = (text: string) => ({ claims: [{ claim: text, entities_involved: ['ETH'] }] });
    seedSource(db, { source_id: 's-active', compile_status: 'active' });
    seedExtraction(db, { source_id: 's-active', llm_output: llm('ETH has a supply cap.') });
    seedSource(db, { source_id: 's-pending', compile_status: 'extracted' });
    seedExtraction(db, { source_id: 's-pending', llm_output: llm('ETH is new.') });
    seedSource(db, { source_id: 's-archived', compile_status: 'active' });
    db.prepare(`UPDATE sources SET status = 'archived' WHERE source_id = 's-archived'`).run();
    seedExtraction(db, { source_id: 's-archived', llm_output: llm('ETH is old.') });

    const claims = loadWikiClaims(db);
    expect(claims.map((c) => [c.source_id, c.subjects])).toEqual([['s-active', ['Ethereum']]]);
    expect(subjectPages(db).get('ethereum')).toEqual({ page_id: 'p-eth', title: 'Ethereum' });
  });
});

describe('numbers and dates', () => {
  it('reads numbers without separators and months as numbers', () => {
    expect([...numbersIn('In March 2009, 1,200 users; 08 nodes; 3.5%')].sort()).toEqual(['1200', '2009', '3.5', '8', 'm3'].sort());
  });

  it('differ only when each side gives one the other lacks', () => {
    expect(numbersDiffer(numbersIn('launched in 2008'), numbersIn('launched in 2009'))).toBe(true);
    expect(numbersDiffer(numbersIn('in March 2009'), numbersIn('in January 2009'))).toBe(true);
    expect(numbersDiffer(numbersIn('launched in 2009 with 21 million coins'), numbersIn('capped at 21 million'))).toBe(false);
    expect(numbersDiffer(numbersIn('launched in 2009'), numbersIn('launched early'))).toBe(false);
  });
});

describe('findCandidatePairs', () => {
  it('pairs claims of different sources on a shared subject that has a page', () => {
    const claims = [
      claim('s1', 'Bitcoin launched in 2009.', ['Bitcoin']),
      claim('s1', 'Bitcoin uses proof of work.', ['Bitcoin']),
      claim('s2', 'Bitcoin launched in 2008.', ['Bitcoin']),
      claim('s3', 'Lisbon is sunny.', ['Lisbon']),
      claim('s4', 'Lisbon has trams.', ['Lisbon']),
      // No page for Lisbon Tram: never an anchor.
      claim('s5', 'The tram is yellow.', ['Lisbon Tram']),
      claim('s6', 'The tram is old.', ['Lisbon Tram']),
      // Two unrelated claims keep "Bitcoin" (3 of 9) under the 35% share.
      claim('f1', 'Unrelated 1.', ['X1']),
      claim('f2', 'Unrelated 2.', ['X2']),
    ];
    const pairs = findCandidatePairs(claims, { pageBySubject: pages('Bitcoin', 'Lisbon'), judged: new Set() });
    const named = pairs.map((p) => [p.first.text, p.second.text, p.subject].sort());
    // Never two claims of one source; the launch-year mismatch comes first.
    expect(pairs[0].number_mismatch).toBe(true);
    expect(pairs[0].pair_key).toBe(pairKey(claims[0].key, claims[2].key));
    expect(named).toHaveLength(3);
    expect(named).toContainEqual(['Bitcoin', 'Bitcoin uses proof of work.', 'Bitcoin launched in 2008.'].sort());
    expect(named).toContainEqual(['Lisbon', 'Lisbon has trams.', 'Lisbon is sunny.'].sort());
    expect(pairs.every((p) => p.first.source_id !== p.second.source_id)).toBe(true);
  });

  it('drops a subject found in more than 35% of claims, and anchors on the rarer one', () => {
    // "Ethereum" is in 4 of 10 claims (40%): too common. "Staking" is in 2.
    const claims = [
      claim('s1', 'Ethereum staking pays 4 percent.', ['Ethereum', 'Staking']),
      claim('s2', 'Ethereum staking pays 6 percent.', ['Ethereum', 'Staking']),
      claim('s3', 'Ethereum is a blockchain.', ['Ethereum']),
      claim('s4', 'Ethereum is a computer.', ['Ethereum']),
      ...Array.from({ length: 6 }, (_, i) => claim(`t${i}`, `Other fact ${i}.`, [`Thing ${i}`])),
    ];
    const pairs = findCandidatePairs(claims, { pageBySubject: pages('Ethereum', 'Staking'), judged: new Set() });
    expect(pairs).toHaveLength(1);
    expect(pairs[0].subject).toBe('Staking');
    expect(pairs[0].page_id).toBe('page-1');
  });

  it(`keeps the ${PAIRS_PER_CLAIM} most similar claims per claim`, () => {
    const focus = claim('new', 'Solana processes 65000 transactions per second.', ['Solana']);
    const others = [
      claim('o1', 'Solana processes 50000 transactions per second.', ['Solana']),
      claim('o2', 'Solana processes transactions quickly.', ['Solana']),
      claim('o3', 'Solana transactions are cheap per second.', ['Solana']),
      claim('o4', 'Solana was founded by Anatoly.', ['Solana']),
      claim('o5', 'Solana had outages.', ['Solana']),
    ];
    // Twelve unrelated claims keep "Solana" (6 of 18) under the 35% share.
    const filler = Array.from({ length: 12 }, (_, i) => claim(`f${i}`, `Unrelated ${i}.`, [`X${i}`]));
    const pairs = findCandidatePairs([focus, ...others, ...filler], {
      pageBySubject: pages('Solana'),
      judged: new Set(),
      newSourceIds: new Set(['new']),
    });
    expect(pairs).toHaveLength(PAIRS_PER_CLAIM);
    expect(pairs.every((p) => p.first.source_id === 'new')).toBe(true);
    expect(pairs.map((p) => p.second.source_id)).not.toContain('o4');
    expect(pairs.map((p) => p.second.source_id)).not.toContain('o5');
    // 65000 vs 50000: the mismatch ranks first.
    expect(pairs[0].second.source_id).toBe('o1');
  });

  it('ranks claims sharing a word first, then fills with the rest by claim key, each scored once', () => {
    const focus = claim('new', 'Solana validators vote on blocks.', ['Solana', 'Validators']);
    const voting = claim('o1', 'Solana validators vote on blocks.', ['Solana', 'Validators']);
    const strangers = ['Anatoly founded it.', 'Outages happened twice.', 'Fees stay low.', 'Rust programs run there.'].map((text, i) =>
      claim(`o${i + 2}`, text, ['Solana']),
    );
    const filler = Array.from({ length: 14 }, (_, i) => claim(`f${i}`, `Unrelated ${i}.`, [`X${i}`]));
    const pairs = findCandidatePairs([focus, voting, ...strangers, ...filler], {
      pageBySubject: pages('Solana', 'Validators'),
      judged: new Set(),
      newSourceIds: new Set(['new']),
    });
    // The same words through two shared subjects: one cosine, not two.
    expect(pairs[0].second).toBe(voting);
    expect(pairs[0].similarity).toBeCloseTo(1, 9);
    const byKey = [...strangers].sort((a, b) => (a.key < b.key ? -1 : 1)).slice(0, PAIRS_PER_CLAIM - 1);
    expect(pairs.slice(1).map((p) => [p.second, p.similarity])).toEqual(byKey.map((c) => [c, 0]));
  });

  it('leaves judged pairs out after choosing the top pairs, so the set shrinks to nothing', () => {
    const claims = [
      claim('s1', 'Rust 1.0 shipped in 2015.', ['Rust']),
      claim('s2', 'Rust 1.0 shipped in 2014.', ['Rust']),
      claim('s3', 'Rust 1.0 shipped in May 2015.', ['Rust']),
      claim('s4', 'Rust has no garbage collector.', ['Rust']),
      ...Array.from({ length: 8 }, (_, i) => claim(`f${i}`, `Unrelated ${i}.`, [`X${i}`])),
    ];
    const options = { pageBySubject: pages('Rust'), judged: new Set<string>() };
    const all = findCandidatePairs(claims, options);
    expect(all.length).toBeGreaterThan(0);
    const judged = new Set(all.slice(0, 2).map((p) => p.pair_key));
    const rest = findCandidatePairs(claims, { ...options, judged });
    expect(rest.map((p) => p.pair_key)).toEqual(all.slice(2).map((p) => p.pair_key));
    expect(findCandidatePairs(claims, { ...options, judged: new Set(all.map((p) => p.pair_key)) })).toEqual([]);
  });

  it("in a compile, pairs only the new sources' claims, with any other source", () => {
    const claims = [
      claim('old1', 'Go was released in 2009.', ['Go']),
      claim('old2', 'Go was released in 2012.', ['Go']),
      claim('new1', 'Go was released in 2010.', ['Go']),
      ...Array.from({ length: 6 }, (_, i) => claim(`f${i}`, `Unrelated ${i}.`, [`X${i}`])),
    ];
    const pairs = findCandidatePairs(claims, { pageBySubject: pages('Go'), judged: new Set(), newSourceIds: new Set(['new1']) });
    expect(pairs).toHaveLength(2);
    expect(pairs.every((p) => p.first.source_id === 'new1')).toBe(true);
  });
});
