/**
 * A small wiki with the mistake the wiki repair puts right (plan Phase 4),
 * and a fake nlp-service for it: no real LLM call is ever made.
 *
 * Old name matching sent five sources to "Ethereum Foundation": three name
 * "Ethereum" (which has its own page) and one names "ETH" (set aside: the AI
 * says it is a different thing). One names "The Ethereum Foundation" (set
 * aside, the AI confirms it). "ETC" is set aside and the AI cannot decide.
 * An owner-retired row must never change. Two labels mean the same thing.
 */

import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';

import type Database from 'better-sqlite3';
import { vi } from 'vitest';

import { DATA_ROOT } from '../../lib/db';
import { seedExtraction, seedPage, seedProvenance, seedSource } from './test-db';

export const EF = 'page-ef';
export const ETH = 'page-eth';
export const S = { ef: 'src-ef', eth1: 'src-eth1', eth2: 'src-eth2', eth3: 'src-eth3', ethTicker: 'src-ticker', ethOwn: 'src-eth-own', theEf: 'src-the-ef' };

const BODY = 'Ethereum is a blockchain with smart contracts and its own coin, run by many nodes. '.repeat(4);

export function pageMarkdown(title: string, category: string, body = BODY): string {
  return ['---', `title: ${title}`, 'page_type: entity', `category: ${category}`, 'summary: A summary.', '---', '', body, ''].join('\n');
}

export function writePageFile(pageId: string, markdown: string): void {
  const file = path.join(DATA_ROOT, 'pages', `${pageId}.md.gz`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, zlib.gzipSync(Buffer.from(markdown)));
}

function source(db: Database.Database, id: string, entities: Array<{ name: string; type: string; context?: string }>): void {
  seedSource(db, { source_id: id, title: `Article ${id}`, raw_markdown: `${id}: ${BODY}`, compile_status: 'compiled' });
  seedExtraction(db, { source_id: id, llm_output: { entities, concepts: [], relationships: [] } });
}

export function seedRepairWiki(db: Database.Database): void {
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('min_draft_chars', '100')").run();
  source(db, S.ef, [{ name: 'Ethereum Foundation', type: 'ORG', context: 'the non-profit that funds Ethereum work' }]);
  for (const id of [S.eth1, S.eth2, S.eth3]) source(db, id, [{ name: 'Ethereum', type: 'PRODUCT', context: 'the blockchain' }]);
  source(db, S.ethTicker, [{ name: 'ETH', type: 'PRODUCT', context: 'the coin of Ethereum' }]);
  source(db, S.ethOwn, [{ name: 'Ethereum', type: 'PRODUCT', context: 'the blockchain' }]);
  source(db, S.theEf, [{ name: 'The Ethereum Foundation', type: 'ORG', context: 'a Swiss foundation' }]);

  seedPage(db, { page_id: EF, title: 'Ethereum Foundation', page_type: 'entity', category: 'Crypto', summary: 'The foundation.' });
  seedPage(db, { page_id: ETH, title: 'Ethereum', page_type: 'entity', category: 'Cryptocurrency', summary: 'The chain.' });
  writePageFile(EF, pageMarkdown('Ethereum Foundation', 'Crypto'));
  writePageFile(ETH, pageMarkdown('Ethereum', 'Cryptocurrency'));
  for (const id of [S.ef, S.eth1, S.eth2, S.eth3, S.ethTicker, S.theEf]) seedProvenance(db, EF, id);
  seedProvenance(db, ETH, S.ethOwn);
  db.prepare('UPDATE pages SET source_count = 6 WHERE page_id = ?').run(EF);

  // What the old matching stored: five sources credited to the foundation.
  db.prepare(
    `UPDATE entity_mentions SET canonical_name = 'Ethereum Foundation'
      WHERE source_id IN (?, ?, ?, ?, ?)`
  ).run(S.eth1, S.eth2, S.eth3, S.ethTicker, S.theEf);

  const alias = db.prepare(
    'INSERT INTO aliases (alias, canonical_name, method, status, status_reason) VALUES (?, ?, ?, ?, ?)'
  );
  alias.run('ETH', 'Ethereum Foundation', null, 'suspended', 'token_extension');
  alias.run('The Ethereum Foundation', 'Ethereum Foundation', null, 'suspended', 'content_words');
  alias.run('ETC', 'Ethereum Foundation', null, 'suspended', 'content_words');
  alias.run('Ether Foundation', 'Ethereum Foundation', null, 'retired', 'owner');
  alias.run('EthFdn', 'Ethereum Foundation', 'skeleton', 'active', null);
}

export const PRICING = {
  model: 'deepseek-flash',
  provider: 'deepseek',
  input_usd_per_m: 0.3,
  output_usd_per_m: 1.2,
  cached_input_usd_per_m: 0.006,
  thinking_billed_as: 'output',
  draft_thinking_budget: 1024,
  draft_thinking_budget_is_cap: false,
  draft_max_output_tokens: 16384,
  draft_prompt_char_cap: 128000,
  claim_judge_thinking_budget: 512,
  claim_judge_max_output_tokens: 8192,
  disambiguate_thinking_budget: 512,
  disambiguate_max_output_tokens: 8192,
  label_merge_thinking_budget: 512,
  label_merge_max_output_tokens: 4096,
};

export interface FakeNlp {
  usageTotal: number;
  /** USD added to the day's total per LLM call. */
  spendPerCall: number;
  /** Status the next calls of a path answer with, instead of 200. */
  fail: Partial<Record<'disambiguate' | 'draft' | 'labels' | 'pricing', number>>;
  /** Draft calls answered before `fail.draft` applies. */
  draftOkBefore: number;
  disambiguateBodies: Array<{ pairs: Array<{ pair_id: string; entity_a: { name: string }; entity_b: { name: string } }> }>;
  draftBodies: Array<{ title: string; source_contents: Array<{ source_id: string }> }>;
  writes: string[];
  /** Each page write and whether it archived the file it replaced (file_store.py). */
  writeArchives: Array<{ page_id: string; archive: boolean }>;
  labelBodies: Array<{ existing_labels: string[]; new_labels: string[] }>;
  verdict: (a: string, b: string) => { decision: string; reason: string };
  onDisambiguate?: () => void;
}

const DEFAULT_VERDICTS: Record<string, { decision: string; reason: string }> = {
  ETH: { decision: 'different', reason: 'ETH is the coin, not the foundation' },
  'The Ethereum Foundation': { decision: 'same', reason: 'same organisation' },
  ETC: { decision: 'ambiguous', reason: 'not enough context' },
};

export function mockRepairNlp(db: Database.Database): FakeNlp {
  const nlp: FakeNlp = {
    usageTotal: 0,
    spendPerCall: 0.001,
    fail: {},
    draftOkBefore: 0,
    disambiguateBodies: [],
    draftBodies: [],
    writes: [],
    writeArchives: [],
    labelBodies: [],
    verdict: (a) => DEFAULT_VERDICTS[a] ?? { decision: 'same', reason: 'same thing' },
  };
  const json = (init?: RequestInit) => JSON.parse(String(init?.body ?? '{}'));
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      const u = String(url);
      if (u.includes('/llm/pricing')) {
        return nlp.fail.pricing ? new Response('down', { status: nlp.fail.pricing }) : Response.json(PRICING);
      }
      if (u.endsWith('/llm/usage')) {
        return Response.json({ date: '2026-10-24', total_usd: nlp.usageTotal, call_count: 0, daily_cap_usd: 5, remaining_usd: Math.max(0, 5 - nlp.usageTotal) });
      }
      if (u.endsWith('/resolve/disambiguate')) {
        nlp.onDisambiguate?.();
        if (nlp.fail.disambiguate) return Response.json({ detail: 'nope' }, { status: nlp.fail.disambiguate });
        const body = json(init);
        nlp.disambiguateBodies.push(body);
        nlp.usageTotal += nlp.spendPerCall;
        const results = body.pairs.map((p: { pair_id: string; entity_a: { name: string }; entity_b: { name: string } }) => ({
          pair_id: p.pair_id,
          entity_a: p.entity_a.name,
          entity_b: p.entity_b.name,
          canonical: p.entity_b.name,
          ...nlp.verdict(p.entity_a.name, p.entity_b.name),
        }));
        return Response.json({ results, failed_pairs: 0 });
      }
      if (u.endsWith('/pipeline/draft-page')) {
        const body = json(init);
        if (nlp.fail.draft && nlp.draftBodies.length >= nlp.draftOkBefore) {
          return Response.json({ detail: 'nope' }, { status: nlp.fail.draft });
        }
        nlp.draftBodies.push(body);
        nlp.usageTotal += nlp.spendPerCall;
        const page = db.prepare('SELECT category FROM pages WHERE title = ?').get(body.title) as { category: string };
        return Response.json({ markdown: pageMarkdown(body.title, page.category, `Rewritten [S1]. ${BODY}`) });
      }
      if (u.endsWith('/storage/write-page')) {
        const { page_id, markdown, archive } = json(init) as { page_id: string; markdown: string; archive?: boolean };
        nlp.writes.push(page_id);
        nlp.writeArchives.push({ page_id, archive: archive ?? true });
        writePageFile(page_id, markdown);
        return Response.json({ current_path: `/data/pages/${page_id}.md.gz`, previous_path: `/data/pages/${page_id}.20261024-120000.md.gz` });
      }
      if (u.endsWith('/pipeline/consolidate-labels')) {
        if (nlp.fail.labels) return Response.json({ detail: 'nope' }, { status: nlp.fail.labels });
        const body = json(init);
        nlp.labelBodies.push(body);
        nlp.usageTotal += nlp.spendPerCall;
        const items = body.new_labels.includes('Crypto') && body.new_labels.includes('Cryptocurrency')
          ? [{ label: 'Crypto', into: 'Cryptocurrency', reason: 'short form' }]
          : [];
        return Response.json({ items, count: items.length });
      }
      if (u.endsWith('/vectors/upsert')) return Response.json({ ok: true });
      return new Response('not found', { status: 404 });
    }),
  );
  return nlp;
}
