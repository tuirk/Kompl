/**
 * Activity feed rows for the page update (lib/activity-events.tsx): each
 * updated page reads UPGRADED / "updated to the <rules> writing rules" (the
 * internal page_redrafted type is kept for existing rows), and each run
 * logs one page_upgrade_run row per phase with its counts. The rules version
 * comes from the row, so a later release's rows read correctly too.
 */

import type { ReactElement } from 'react';
import { describe, expect, it } from 'vitest';
import { getEventDef, resolveBadge, type FeedActivityRow } from '../lib/activity-events';

function row(action_type: string, details: Record<string, unknown>): FeedActivityRow {
  return {
    id: 1,
    timestamp: '2026-10-10 10:00:00',
    action_type,
    source_id: null,
    source_title: null,
    details: JSON.stringify(details),
  };
}

function text(node: unknown): string {
  if (node === null || node === undefined || typeof node === 'boolean') return '';
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(text).join('');
  return text((node as ReactElement<{ children?: unknown }>).props.children);
}

describe('page_redrafted', () => {
  it('reads as an update to the writing rules the row recorded', () => {
    const r = row('page_redrafted', { page_id: 'bitcoin', title: 'Bitcoin', model: 'deepseek-flash', draft_rules: 'v0.4' });
    const def = getEventDef('page_redrafted')!;
    expect(resolveBadge(def, r)).toEqual({ label: 'UPGRADED', tone: 'neut' });
    const content = def.render(r);
    expect(text(content.primary)).toBe('Bitcoin');
    expect(text(content.secondary)).toBe('updated to the v0.4 writing rules');
    expect(text(content.secondary)).not.toMatch(/redraft|rewrit/i);

    expect(text(def.render(row('page_redrafted', { page_id: 'b', title: 'B', draft_rules: 'v0.5' })).secondary)).toBe(
      'updated to the v0.5 writing rules',
    );
    // Rows written before the version was recorded.
    expect(text(def.render(row('page_redrafted', { page_id: 'b', title: 'B' })).secondary)).toBe(
      'updated to the current writing rules',
    );
  });
});

describe('page_upgrade_run', () => {
  const def = getEventDef('page_upgrade_run')!;

  it('summarises a started run', () => {
    const r = row('page_upgrade_run', { phase: 'started', rules: 'v0.4', pages: 37, model: 'deepseek-flash' });
    expect(resolveBadge(def, r)).toEqual({ label: 'UPGRADING', tone: 'neut' });
    const content = def.render(r);
    expect(text(content.primary)).toBe('Page update to the v0.4 writing rules started');
    expect(text(content.secondary)).toBe('37 pages');
    expect(content.isError).toBe(false);
  });

  it('summarises a finished run with its counts', () => {
    const r = row('page_upgrade_run', { phase: 'finished', rules: 'v0.5', pages: 37, updated: 35, skipped: 1, failed: 1 });
    expect(resolveBadge(def, r)).toEqual({ label: 'UPGRADED', tone: 'mint' });
    const content = def.render(r);
    expect(text(content.primary)).toBe('Page update to the v0.5 writing rules finished');
    expect(text(content.secondary)).toBe('35 updated · 1 skipped · 1 failed');
  });

  it('says why a run stopped', () => {
    const r = row('page_upgrade_run', { phase: 'stopped', reason: 'consecutive_failures', updated: 2, skipped: 0, failed: 3 });
    expect(resolveBadge(def, r)).toEqual({ label: 'STOPPED', tone: 'dim' });
    const content = def.render(r);
    expect(text(content.secondary)).toBe('2 updated · 0 skipped · 3 failed · 3 failures in a row');
    expect(content.isError).toBe(true);

    const ceiling = def.render(row('page_upgrade_run', { phase: 'stopped', reason: 'daily_cost_ceiling', updated: 4 }));
    expect(text(ceiling.secondary)).toBe("4 updated · 0 skipped · 0 failed · today's spending limit reached");
    expect(ceiling.isError).toBe(false);
  });
});
