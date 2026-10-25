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
