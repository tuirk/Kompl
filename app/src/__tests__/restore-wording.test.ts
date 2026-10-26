/**
 * Restore wording: a backup restores only into a wiki with no pages
 * (lib/wiki-empty.ts), so onboarding offers the restore link only then, and
 * shows the compile model by its name, never its raw id.
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('next/navigation', () => ({
  usePathname: () => '/onboarding',
  useRouter: () => ({ push: () => {} }),
  useSearchParams: () => new URLSearchParams(),
}));

import OnboardingClient from '../app/onboarding/OnboardingClient';
import { countUserPages } from '../lib/wiki-empty';
import { REPAIR_COPY_RESTORE, RESTORE_NEEDS_EMPTY } from '../lib/restore-copy';
import { seedPage, setupTestDb, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

describe('countUserPages', () => {
  it('ignores the Saved Links system page', () => {
    handle = setupTestDb();
    seedPage(handle.db, { page_id: 'saved-links', title: 'Saved Links' });
    expect(countUserPages()).toBe(0);
    seedPage(handle.db, { page_id: 'bitcoin', title: 'Bitcoin' });
    expect(countUserPages()).toBe(1);
  });
});

describe('onboarding restore link', () => {
  const render = (wikiEmpty: boolean) => renderToString(createElement(OnboardingClient, { wikiEmpty }));

  it('is offered on an empty wiki', () => {
    const html = render(true);
    expect(html).toContain('href="/settings#import"');
    expect(html).toContain('Restore it instead');
  });

  it('is not offered on a wiki with pages', () => {
    const html = render(false);
    expect(html).not.toContain('href="/settings#import"');
    expect(html).not.toContain('empty wiki only');
  });
});

describe('restore copy', () => {
  it('says plainly that a restore needs a new, empty Kompl and how to get there', () => {
    expect(RESTORE_NEEDS_EMPTY).toMatch(/new, empty Kompl/);
    expect(REPAIR_COPY_RESTORE).toMatch(/isn't a one-click undo/);
    expect(REPAIR_COPY_RESTORE).toMatch(/set up a new Kompl, skip onboarding/);
  });
});

describe('a stopped wiki repair', () => {
  const stoppedRun = {
    run_id: 'r1', status: 'stopped', stop_requested: false, model: 'deepseek-flash', model_label: 'DeepSeek',
    step: 'links', steps_done: ['backup', 'aliases', 'mentions'],
    backup: { file: 'kompl-repair-backup.kompl.zip', bytes: 10, taken_at: '2026-10-26T00:00:00Z' },
    aliases: { total: 1, judged: 1, confirmed: 1, retired: 0, undecided: 0 },
    mentions: { sources: 3, pages: 1 }, links: { pages: 2, links: 3, missed: 0 }, senses: null, titles: null,
    pages: { total: 0, done: 0, rebuilt: 0, skipped: 0, failed: 0, consecutive_failures: 0, current_title: null },
    labels: null,
    confirmed: { aliases: 1, max_pages: 1, cost_usd_low: 0, cost_usd_high: 0.01, minutes_low: 1, minutes_high: 2 },
    spend_limit_usd: 0.015, spent_usd: 0.001, stop_reason: 'user', last_error: null, issues: [],
    started_at: '2026-10-26T00:00:00Z', finished_at: '2026-10-26T00:01:00Z', pages_waiting: 1, waiting_titles: ['Ethereum'],
  } as const;

  it('says the step it stopped in is done in part, and both ways on: run it again, or restore the copy', async () => {
    const { RunOutcome } = await import('../app/settings/RepairWikiParts');
    const html = renderToString(createElement(RunOutcome, { run: structuredClone(stoppedRun) as never }));
    // The links step changed two pages before the stop: it is neither done nor untouched.
    expect(html).toContain('the step it stopped in may be part done');
    expect(html).not.toContain('the rest were not.');
    expect(html).toContain('To finish, select Repair wiki again');
    expect(html).toContain("This isn&#x27;t a one-click undo");
    expect(html).toContain('href="/api/wiki/repair/backup"');
  });
});
