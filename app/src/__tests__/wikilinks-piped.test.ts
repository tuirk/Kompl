/**
 * Piped wikilinks [[Target|label]] — written by the deterministic injector
 * when the matched text differs from the canonical title. Regression: they
 * rendered as literal "Target|label" text and never reached page_links, so
 * backlinks and the graph undercounted.
 */

import { describe, it, expect, afterEach } from 'vitest';
import { findWikilinks, replaceWikilinks, stripWikilinks } from '../lib/wikilink-syntax';
import { syncPageWikilinks } from '../lib/wikilinks';
import { stripWikilinkBrackets } from '../lib/wikilink-render';
import { setupTestDb, seedPage, type TestDbHandle } from './helpers/test-db';

describe('wikilink syntax', () => {
  it('parses plain and piped links', () => {
    expect(findWikilinks('See [[Bitcoin]] and [[Ethereum Foundation|Ethereum]].')).toEqual([
      { target: 'Bitcoin', label: 'Bitcoin', index: 4, length: 11 },
      { target: 'Ethereum Foundation', label: 'Ethereum', index: 20, length: 32 },
    ]);
  });

  it('replaces with target and label available', () => {
    expect(
      replaceWikilinks('a [[X|y]] b [[Z]]', ({ target, label }) => `<${target}:${label}>`),
    ).toBe('a <X:y> b <Z:Z>');
  });

  it('strips to the display label', () => {
    expect(stripWikilinks('the [[Ethereum Foundation|Ethereum]] network')).toBe('the Ethereum network');
    expect(stripWikilinkBrackets('[[Bitcoin]] mining')).toBe('Bitcoin mining');
  });

  it('ignores empty and unterminated brackets', () => {
    expect(findWikilinks('[[]] [[open')).toEqual([]);
  });
});

describe('syncPageWikilinks', () => {
  let handle: TestDbHandle | null = null;
  afterEach(() => {
    handle?.cleanup();
    handle = null;
  });

  it('records piped links against their target page and skips self-links', () => {
    handle = setupTestDb();
    const btc = seedPage(handle.db, { title: 'Bitcoin' });
    const ef = seedPage(handle.db, { title: 'Ethereum Foundation' });
    const titleMap = new Map([
      ['bitcoin', btc],
      ['ethereum foundation', ef],
    ]);

    syncPageWikilinks(
      handle.db,
      btc,
      'Compared with the [[Ethereum Foundation|Ethereum]] network, [[Bitcoin]] is older.',
      titleMap,
    );

    const rows = handle.db
      .prepare(`SELECT source_page_id, target_page_id FROM page_links WHERE link_type = 'wikilink'`)
      .all();
    expect(rows).toEqual([{ source_page_id: btc, target_page_id: ef }]);
  });
});
