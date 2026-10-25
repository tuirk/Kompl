/**
 * mergeDraftLabels: the 'labels' compile step (plan 2.3, owner decision D7).
 *
 * After drafting, one AI call merges the category labels this compile added
 * into labels that mean the same thing. It rewrites only the `category:` line
 * of this session's drafts waiting to commit; the commit then writes the
 * pages through the outbox. Labels the wiki already had are never renamed.
 */

import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { getEventDef, type FeedActivityRow } from '../lib/activity-events';
import { MAX_EXISTING_LABELS, mergeDraftLabels } from '../lib/compile/label-merge';
import { extractFrontmatterField } from '../lib/yaml-frontmatter';
import { seedPage, seedPagePlan, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  vi.unstubAllGlobals();
  handle?.cleanup();
  handle = null;
});

const SESSION = 'sess-labels';
const BODY = '## Overview\n\ncategory: Crypto is how this line reads in the body.\n';
const draft = (title: string, category: string | null) =>
  `---\ntitle: "${title}"\n${category === null ? '' : `category: ${category}\n`}summary: "About ${title}."\n---\n\n${BODY}`;

function plan(title: string, category: string | null, extra: { action?: string; existing_page_id?: string } = {}): string {
  return seedPagePlan(handle!.db, {
    session_id: SESSION,
    title,
    draft_status: 'crossreffed',
    draft_content: draft(title, category),
    ...extra,
  });
}

function draftOf(plan_id: string): string {
  return (handle!.db.prepare('SELECT draft_content FROM page_plans WHERE plan_id = ?').get(plan_id) as {
    draft_content: string;
  }).draft_content;
}

interface Call {
  existing_labels: string[];
  new_labels: string[];
  compile_model: string;
}

/** Stubs nlp-service's consolidate call; `answer` sees each request body. */
function stubConsolidate(answer: (body: Call) => Response): Call[] {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string | URL, init?: RequestInit) => {
      if (!String(url).endsWith('/pipeline/consolidate-labels')) throw new Error(`unexpected fetch: ${String(url)}`);
      const body = JSON.parse(String(init?.body)) as Call;
      calls.push(body);
      return answer(body);
    })
  );
  return calls;
}

const merges = (...items: Array<[string, string]>) =>
  new Response(JSON.stringify({ items: items.map(([label, into]) => ({ label, into, reason: 'same category' })), count: items.length }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

const active = () => {};

function seedWiki(): void {
  seedPage(handle!.db, { page_id: 'w1', title: 'Bitcoin', category: 'Cryptocurrency' });
  seedPage(handle!.db, { page_id: 'w2', title: 'Ether', category: 'Cryptocurrency' });
  seedPage(handle!.db, { page_id: 'w3', title: 'Lisbon', category: 'Travel' });
  seedPage(handle!.db, { page_id: 'w4', title: 'Misc', category: 'Uncategorized' });
}

describe('mergeDraftLabels', () => {
  it('merges a new label into the wiki label that means the same, in the frontmatter only', async () => {
    handle = setupTestDb();
    seedWiki();
    const a = plan('Solana', 'Crypto');
    const b = plan('Jazz', 'Music');
    const calls = stubConsolidate(() => merges(['Crypto', 'Cryptocurrency']));

    const outcome = await mergeDraftLabels(SESSION, 'deepseek-flash', active);

    expect(calls).toEqual([
      { existing_labels: ['Cryptocurrency', 'Travel'], new_labels: ['Crypto', 'Music'], compile_model: 'deepseek-flash' },
    ]);
    expect(draftOf(a)).toBe(draft('Solana', 'Cryptocurrency'));
    expect(draftOf(b)).toBe(draft('Jazz', 'Music'));
    expect(outcome).toEqual({ detail: '1 category merged (1 page)', merged: 1, drafts: 1 });
    const activity = handle.db
      .prepare(`SELECT session_id, step_key, details FROM activity_log WHERE action_type = 'labels_merged'`)
      .all() as Array<{ session_id: string; step_key: string; details: string }>;
    expect(activity).toHaveLength(1);
    expect(activity[0].session_id).toBe(SESSION);
    expect(activity[0].step_key).toBe('labels');
    expect(JSON.parse(activity[0].details)).toEqual({
      merged: 1,
      drafts: 1,
      merges: [{ label: 'Crypto', into: 'Cryptocurrency', pages: 1 }],
    });
  });

  it('two new labels that mean the same end up as one, case variants included', async () => {
    handle = setupTestDb();
    const a = plan('Solana', 'Crypto');
    const b = plan('Cardano', 'crypto');
    const c = plan('Tezos', 'Cryptocurrency');
    const d = plan('Polkadot', 'Cryptocurrency');
    const e = plan('Algorand', 'Cryptocurrency');
    const calls = stubConsolidate(() => merges(['Crypto', 'Cryptocurrency']));

    const outcome = await mergeDraftLabels(SESSION, 'deepseek-flash', active);

    // Most-used first; "crypto" only differs in case from "Crypto" and is
    // never sent.
    expect(calls[0].new_labels).toEqual(['Cryptocurrency', 'Crypto']);
    for (const id of [a, b, c, d, e]) expect(draftOf(id)).toContain('\ncategory: Cryptocurrency\n');
    expect(outcome.merged).toBe(2);
    expect(outcome.drafts).toBe(2);
  });

  it('a case variant of a wiki label takes the wiki spelling without a call', async () => {
    handle = setupTestDb();
    seedWiki();
    const a = plan('Porto', 'travel');
    const calls = stubConsolidate(() => merges());

    const outcome = await mergeDraftLabels(SESSION, 'deepseek-flash', active);

    expect(calls).toEqual([]);
    expect(draftOf(a)).toBe(draft('Porto', 'Travel'));
    expect(outcome.detail).toBe('1 category merged (1 page)');
  });

  it('sends nothing when the drafts add no new label', async () => {
    handle = setupTestDb();
    seedWiki();
    plan('Porto', 'Travel');
    plan('Untitled', null);
    plan('Notes', 'Uncategorized');
    plan('Stray', 'General');
    seedPagePlan(handle.db, { session_id: SESSION, title: 'Lisbon', action: 'provenance-only', existing_page_id: 'w3', draft_status: 'crossreffed' });
    const calls = stubConsolidate(() => merges());

    const outcome = await mergeDraftLabels(SESSION, 'deepseek-flash', active);

    expect(calls).toEqual([]);
    expect(outcome).toEqual({ detail: 'no new categories', merged: 0, drafts: 0 });
  });

  it("an update keeps its page's label, so its draft's label is not new", async () => {
    handle = setupTestDb();
    seedWiki();
    const a = plan('Lisbon', 'Trips', { action: 'update', existing_page_id: 'w3' });
    const calls = stubConsolidate(() => merges());

    await mergeDraftLabels(SESSION, 'deepseek-flash', active);

    expect(calls).toEqual([]);
    expect(draftOf(a)).toBe(draft('Lisbon', 'Trips'));
  });

  it('an update of a page without a label counts, since its draft gives the page one', async () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'bare', title: 'Bare', category: null });
    plan('Bare', 'Gardening', { action: 'update', existing_page_id: 'bare' });
    const calls = stubConsolidate(() => merges());

    await mergeDraftLabels(SESSION, 'deepseek-flash', active);

    expect(calls[0].new_labels).toEqual(['Gardening']);
  });

  it('at the daily cost cap the merge is skipped and the compile goes on', async () => {
    handle = setupTestDb();
    seedWiki();
    const a = plan('Solana', 'Crypto');
    const b = plan('Porto', 'travel');
    stubConsolidate(() => new Response(JSON.stringify({ detail: 'daily_cost_ceiling' }), { status: 503 }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const outcome = await mergeDraftLabels(SESSION, 'deepseek-flash', active);

    expect(draftOf(a)).toBe(draft('Solana', 'Crypto'));
    // The case fix needs no call and still applies.
    expect(draftOf(b)).toBe(draft('Porto', 'Travel'));
    expect(outcome.detail).toBe('1 category merged (1 page) · 1 new not checked: daily cost limit reached');
    expect(log.mock.calls.some(([line]) => String(line).includes('labels_merge_skipped'))).toBe(true);
    log.mockRestore();
  });

  it('a failed call is skipped too', async () => {
    handle = setupTestDb();
    const a = plan('Solana', 'Crypto');
    stubConsolidate(() => new Response('boom', { status: 500 }));
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});

    const outcome = await mergeDraftLabels(SESSION, 'deepseek-flash', active);

    expect(draftOf(a)).toBe(draft('Solana', 'Crypto'));
    expect(outcome.detail).toBe('1 new not checked: merge check failed');
    log.mockRestore();
  });

  it('applies only merges of labels it sent into labels it sent', async () => {
    handle = setupTestDb();
    seedWiki();
    const a = plan('Solana', 'Crypto');
    const b = plan('Jazz', 'Music');
    stubConsolidate(() => merges(['Music', 'Jazz Music'], ['Cryptocurrency', 'Crypto'], ['Travel', 'Cryptocurrency']));

    const outcome = await mergeDraftLabels(SESSION, 'deepseek-flash', active);

    expect(draftOf(a)).toBe(draft('Solana', 'Crypto'));
    expect(draftOf(b)).toBe(draft('Jazz', 'Music'));
    expect(outcome.detail).toBe('2 new, none merged');
  });

  it('a draft rewritten during the call is left as it now is', async () => {
    handle = setupTestDb();
    seedWiki();
    const a = plan('Solana', 'Crypto');
    const newer = draft('Solana', 'Crypto').replace('About Solana.', 'Newer text.');
    stubConsolidate(() => {
      handle!.db.prepare('UPDATE page_plans SET draft_content = ? WHERE plan_id = ?').run(newer, a);
      return merges(['Crypto', 'Cryptocurrency']);
    });

    const outcome = await mergeDraftLabels(SESSION, 'deepseek-flash', active);

    expect(draftOf(a)).toBe(newer);
    expect(outcome.merged).toBe(0);
  });

  it('a compile cancelled during the call applies nothing', async () => {
    handle = setupTestDb();
    seedWiki();
    const a = plan('Solana', 'Crypto');
    stubConsolidate(() => merges(['Crypto', 'Cryptocurrency']));
    const cancelled = () => {
      throw new Error('Cancelled by user');
    };

    await expect(mergeDraftLabels(SESSION, 'deepseek-flash', cancelled)).rejects.toThrow('Cancelled by user');
    expect(draftOf(a)).toBe(draft('Solana', 'Crypto'));
  });

  it('quotes a label that YAML would misread, and it reads back the same', async () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'eth', title: 'Ethics', category: 'AI: Ethics' });
    const a = plan('Alignment', 'AI ethics');
    stubConsolidate(() => merges(['AI ethics', 'AI: Ethics']));

    await mergeDraftLabels(SESSION, 'deepseek-flash', active);

    expect(draftOf(a)).toContain('\ncategory: "AI: Ethics"\n');
    expect(extractFrontmatterField(draftOf(a), 'category')).toBe('AI: Ethics');
  });

  it('sends at most the most used wiki labels', async () => {
    handle = setupTestDb();
    for (let i = 0; i <= MAX_EXISTING_LABELS; i++) {
      seedPage(handle.db, { page_id: `p${i}`, title: `P${i}`, category: `Label ${String(i).padStart(3, '0')}` });
    }
    seedPage(handle.db, { page_id: 'extra', title: 'Extra', category: 'Label 300' });
    plan('Solana', 'Crypto');
    const calls = stubConsolidate(() => merges());

    await mergeDraftLabels(SESSION, 'deepseek-flash', active);

    expect(calls[0].existing_labels).toHaveLength(MAX_EXISTING_LABELS);
    expect(calls[0].existing_labels[0]).toBe('Label 300');
    expect(calls[0].existing_labels).not.toContain('Label 299');
  });
});

describe('activity feed', () => {
  it('renders the merged row', () => {
    const def = getEventDef('labels_merged');
    expect(def).not.toBeNull();
    const row: FeedActivityRow = {
      id: 1, timestamp: '2026-10-24 10:00:00', action_type: 'labels_merged', source_id: null, source_title: null,
      details: JSON.stringify({
        merged: 2, drafts: 3,
        merges: [{ label: 'Crypto', into: 'Cryptocurrency', pages: 2 }, { label: 'AI', into: 'Artificial Intelligence', pages: 1 }],
      }),
    };
    const text = (node: unknown): string => {
      if (node === null || node === undefined || typeof node === 'boolean') return '';
      if (typeof node === 'string' || typeof node === 'number') return String(node);
      if (Array.isArray(node)) return node.map(text).join('');
      return text((node as ReactElement<{ children?: unknown }>).props.children);
    };
    const content = def!.render(row);
    expect(text(content.primary)).toBe('2 duplicate categories merged');
    expect(text(content.secondary)).toBe('Crypto → Cryptocurrency, AI → Artificial Intelligence · 3 pages from this compile');
  });
});
