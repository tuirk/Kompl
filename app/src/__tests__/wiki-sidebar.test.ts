/**
 * Wiki sidebar (lib/wiki-sidebar-prefs.ts + components/WikiSidebar.tsx):
 * stored preferences, the collapse default for narrow windows, the Ctrl+.
 * shortcut, the boot script that applies the collapsed state before the first
 * paint, and the server-rendered markup that hydration relies on.
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import WikiSidebar from '../components/WikiSidebar';
import type { CategoryGroup, PageRow } from '../lib/db';
import {
  NARROW_QUERY,
  SIDEBAR_BOOT_SCRIPT,
  SIDEBAR_COLLAPSED_KEY,
  createLocalPref,
  isToggleShortcut,
  parseCollapsedPref,
  parseOpenCategories,
  resolveCollapsed,
  serializeOpenCategories,
} from '../lib/wiki-sidebar-prefs';

describe('resolveCollapsed', () => {
  it('follows a stored choice whatever the window width', () => {
    for (const narrow of [false, true]) {
      expect(resolveCollapsed('1', narrow)).toBe(true);
      expect(resolveCollapsed('0', narrow)).toBe(false);
      expect(resolveCollapsed('true', narrow)).toBe(true);
      expect(resolveCollapsed('false', narrow)).toBe(false);
    }
  });

  it('starts collapsed on narrow windows when nothing is stored', () => {
    expect(resolveCollapsed(null, true)).toBe(true);
    expect(resolveCollapsed(null, false)).toBe(false);
  });

  it('treats unknown values as no choice', () => {
    for (const raw of ['', 'yes', 'collapsed', '2']) {
      expect(parseCollapsedPref(raw)).toBeNull();
      expect(resolveCollapsed(raw, true)).toBe(true);
      expect(resolveCollapsed(raw, false)).toBe(false);
    }
  });
});

describe('parseOpenCategories', () => {
  const fallback = ['Crypto', 'Science'];

  it('opens the fallback set when nothing is stored', () => {
    expect([...parseOpenCategories(null, fallback)]).toEqual(fallback);
  });

  it('restores a stored list, keeping only strings', () => {
    expect([...parseOpenCategories('["Science", 3, null, "Art"]', fallback)]).toEqual(['Science', 'Art']);
    expect(parseOpenCategories('[]', fallback).size).toBe(0);
  });

  it('falls back on malformed JSON or a non-array', () => {
    for (const raw of ['{', '"Crypto"', '{"Crypto":true}', 'null']) {
      expect([...parseOpenCategories(raw, fallback)]).toEqual(fallback);
    }
  });

  it('round-trips through serializeOpenCategories', () => {
    const open = new Set(['Crypto', 'Uncategorized']);
    expect(parseOpenCategories(serializeOpenCategories(open), [])).toEqual(open);
  });
});

describe('isToggleShortcut', () => {
  const ctrlDot = {
    key: '.',
    ctrlKey: true,
    metaKey: false,
    altKey: false,
    shiftKey: false,
    repeat: false,
    isComposing: false,
  };

  it('matches Ctrl+.', () => {
    expect(isToggleShortcut(ctrlDot)).toBe(true);
  });

  it('ignores Cmd+., other modifiers, other keys, key repeat and IME composition', () => {
    expect(isToggleShortcut({ ...ctrlDot, ctrlKey: false, metaKey: true })).toBe(false);
    expect(isToggleShortcut({ ...ctrlDot, ctrlKey: false })).toBe(false);
    expect(isToggleShortcut({ ...ctrlDot, shiftKey: true })).toBe(false);
    expect(isToggleShortcut({ ...ctrlDot, altKey: true })).toBe(false);
    expect(isToggleShortcut({ ...ctrlDot, metaKey: true })).toBe(false);
    expect(isToggleShortcut({ ...ctrlDot, key: ',' })).toBe(false);
    expect(isToggleShortcut({ ...ctrlDot, repeat: true })).toBe(false);
    expect(isToggleShortcut({ ...ctrlDot, isComposing: true })).toBe(false);
  });
});

describe('SIDEBAR_BOOT_SCRIPT', () => {
  function runBootScript(opts: {
    stored: string | null;
    narrow: boolean;
    storageThrows?: boolean;
    mediaThrows?: boolean;
  }): string | undefined {
    const attributes: Record<string, string> = {};
    const fakeLocalStorage = {
      getItem(key: string) {
        if (opts.storageThrows) throw new Error('storage blocked');
        return key === SIDEBAR_COLLAPSED_KEY ? opts.stored : null;
      },
    };
    const fakeMatchMedia = (query: string) => {
      if (opts.mediaThrows) throw new Error('no matchMedia');
      return { matches: query === NARROW_QUERY && opts.narrow };
    };
    const fakeDocument = {
      currentScript: {
        parentElement: {
          setAttribute(name: string, value: string) {
            attributes[name] = value;
          },
        },
      },
    };
    new Function('localStorage', 'matchMedia', 'document', SIDEBAR_BOOT_SCRIPT)(
      fakeLocalStorage,
      fakeMatchMedia,
      fakeDocument,
    );
    return attributes['data-collapsed'];
  }

  it('sets the same state as resolveCollapsed for every stored value and width', () => {
    for (const stored of [null, '1', '0', 'true', 'false', '', 'yes']) {
      for (const narrow of [false, true]) {
        expect(runBootScript({ stored, narrow })).toBe(resolveCollapsed(stored, narrow) ? 'true' : 'false');
      }
    }
  });

  it('falls back to the width rule when storage is blocked', () => {
    expect(runBootScript({ stored: '0', narrow: true, storageThrows: true })).toBe('true');
    expect(runBootScript({ stored: '1', narrow: false, storageThrows: true })).toBe('false');
  });

  it('stays expanded without matchMedia unless the reader collapsed it', () => {
    expect(runBootScript({ stored: null, narrow: true, mediaThrows: true })).toBe('false');
    expect(runBootScript({ stored: '1', narrow: false, mediaThrows: true })).toBe('true');
  });

  it('is safe to inline in an HTML script element', () => {
    expect(SIDEBAR_BOOT_SCRIPT).not.toMatch(/<\/script|<!--/i);
  });
});

describe('createLocalPref', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function stubWindow(opts: { failReads?: boolean; failWrites?: boolean } = {}) {
    const store = new Map<string, string>();
    const storageListeners = new Set<(e: { key: string | null }) => void>();
    const localStorage = {
      getItem: vi.fn((key: string) => {
        if (opts.failReads) throw new Error('blocked');
        return store.get(key) ?? null;
      }),
      setItem: vi.fn((key: string, value: string) => {
        if (opts.failWrites) throw new Error('quota');
        store.set(key, value);
      }),
    };
    vi.stubGlobal('window', {
      localStorage,
      addEventListener: (type: string, fn: (e: { key: string | null }) => void) => {
        if (type === 'storage') storageListeners.add(fn);
      },
      removeEventListener: (type: string, fn: (e: { key: string | null }) => void) => {
        if (type === 'storage') storageListeners.delete(fn);
      },
    });
    const otherTabWrites = (key: string | null, value?: string) => {
      if (key !== null && value !== undefined) store.set(key, value);
      for (const fn of storageListeners) fn({ key });
    };
    return { store, localStorage, otherTabWrites, storageListeners };
  }

  it('reads storage once and then serves the cached value', () => {
    const { store, localStorage } = stubWindow();
    store.set('k', '1');
    const pref = createLocalPref('k');
    expect(pref.read()).toBe('1');
    expect(pref.read()).toBe('1');
    expect(localStorage.getItem).toHaveBeenCalledTimes(1);
  });

  it('writes through to storage and notifies subscribers', () => {
    const { store } = stubWindow();
    const pref = createLocalPref('k');
    const listener = vi.fn();
    pref.subscribe(listener);
    pref.write('0');
    expect(store.get('k')).toBe('0');
    expect(pref.read()).toBe('0');
    expect(listener).toHaveBeenCalledTimes(1);
  });

  it('keeps working in memory when storage refuses reads and writes', () => {
    stubWindow({ failReads: true, failWrites: true });
    const pref = createLocalPref('k');
    expect(pref.read()).toBeNull();
    pref.write('1');
    expect(pref.read()).toBe('1');
  });

  it('re-reads after another tab changes the key, and ignores other keys', () => {
    const { otherTabWrites } = stubWindow();
    const pref = createLocalPref('k');
    const listener = vi.fn();
    pref.subscribe(listener);
    expect(pref.read()).toBeNull();
    otherTabWrites('other', 'x');
    expect(listener).not.toHaveBeenCalled();
    otherTabWrites('k', '1');
    expect(listener).toHaveBeenCalledTimes(1);
    expect(pref.read()).toBe('1');
  });

  it('stops notifying after unsubscribe', () => {
    const { otherTabWrites, storageListeners } = stubWindow();
    const pref = createLocalPref('k');
    const listener = vi.fn();
    const unsubscribe = pref.subscribe(listener);
    unsubscribe();
    pref.write('1');
    otherTabWrites('k', '0');
    expect(listener).not.toHaveBeenCalled();
    expect(storageListeners.size).toBe(0);
  });
});

describe('WikiSidebar server render', () => {
  function page(page_id: string, title: string, page_type: string, category: string | null): PageRow {
    return {
      page_id,
      title,
      page_type,
      category,
      summary: null,
      content_path: `${page_id}.md`,
      previous_content_path: null,
      last_updated: '2026-10-01T10:00:00Z',
      source_count: 1,
      created_at: '2026-10-01T10:00:00Z',
      pending_content: null,
    };
  }
  const groups: CategoryGroup[] = [
    {
      category: 'Crypto',
      pages: [
        page('bitcoin', 'Bitcoin', 'entity', 'Crypto'),
        page('pow', 'Proof of Work', 'concept', 'Crypto'),
        page('btc-vs-eth', 'Bitcoin vs Ethereum', 'comparison', 'Crypto'),
      ],
    },
    { category: 'Science', pages: [page('entropy', 'Entropy', 'concept', 'Science')] },
  ];

  function render(props: { activePageId?: string; activeCategory?: string }) {
    return renderToString(createElement(WikiSidebar, { initialGroups: groups, ...props }));
  }

  it('renders the expanded state with the boot script as the sidebar’s first child', () => {
    const html = render({ activePageId: 'pow', activeCategory: 'Crypto' });
    expect(html).toMatch(/^<aside class="wiki-sb" data-collapsed="false"[^>]*><script>/);
    expect(html).toContain(`<script>${SIDEBAR_BOOT_SCRIPT}</script>`);
  });

  it('gives the collapse button its disclosure state, target and shortcut', () => {
    const html = render({});
    const button = html.match(/<button[^>]*aria-controls="([^"]+)"[^>]*>/);
    expect(button).not.toBeNull();
    expect(button![0]).toContain('aria-expanded="true"');
    expect(button![0]).toContain('aria-keyshortcuts="Control+."');
    expect(button![0]).toContain('aria-label="Collapse sidebar"');
    expect(html).toContain(`id="${button![1]}"`);
  });

  it('marks the current page and its tree row, with the full title on hover', () => {
    const html = render({ activePageId: 'pow', activeCategory: 'Crypto' });
    const rows = html.match(/<a[^>]*aria-current="page"[^>]*>/g) ?? [];
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => r.includes('href="/wiki/pow"'))).toBe(true);
    expect(rows.filter((r) => r.includes('data-sidebar-reveal')).length).toBe(1);
    expect(html).toContain('title="Proof of Work"');
  });

  it('keeps comparisons out of the category counts and lists them on their own', () => {
    const html = render({});
    expect(html).toMatch(/Crypto<\/span><span[^>]*>2<\/span>/);
    expect(html).toContain('Comparisons');
    expect(html).toContain('href="/wiki/btc-vs-eth"');
  });

  it('links the index, the graph and the activity feed', () => {
    const html = render({});
    for (const href of ['/wiki', '/wiki/graph', '/feed']) {
      expect(html).toContain(`href="${href}"`);
    }
  });
});
