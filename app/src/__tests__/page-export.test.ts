/**
 * Markdown/Obsidian export bodies (lib/page-export.ts): stored [^<source id>]
 * citations become numbered footnotes with definitions, numbered like the
 * page view. Before this, Obsidian showed raw ids ("[^0b4db637-…]").
 */

import { describe, it, expect, afterEach } from 'vitest';
import { exportPageBody } from '../lib/page-export';
import { setupTestDb, seedSource, seedPage, seedProvenance, type TestDbHandle } from './helpers/test-db';

let handle: TestDbHandle | null = null;

afterEach(() => {
  handle?.cleanup();
  handle = null;
});

const EO = '0b4db637-b010-431f-97c5-3dd25e8ed416';
const BTC = '77746c16-3ccf-4315-adc9-d0524be43038';
const GONE = 'a581a3ee-89e1-48c7-b741-4de2246919d3';
const isKnownTitle = () => false;

describe('exportPageBody', () => {
  it('turns stored citations into numbered footnotes with definitions', () => {
    handle = setupTestDb();
    seedSource(handle.db, { source_id: EO, title: 'Ethereum Overview' });
    seedSource(handle.db, { source_id: BTC, title: 'BTC vs ETH Comparison', source_url: 'https://example.com/btc-eth' });
    const pageId = seedPage(handle.db, { title: 'Proof-of-stake', page_type: 'concept' });
    seedProvenance(handle.db, pageId, EO);
    seedProvenance(handle.db, pageId, BTC);
    seedProvenance(handle.db, pageId, BTC, 'updated');

    const raw = [
      '---',
      'title: Proof-of-stake',
      '---',
      '',
      `Ethereum adopted proof-of-stake in 2022.[^${EO}] Bitcoin uses proof-of-work.[^${BTC}][^${EO}]`,
      '',
    ].join('\n');
    const out = exportPageBody(pageId, raw, isKnownTitle);

    expect(out.body).toBe(
      [
        'Ethereum adopted proof-of-stake in 2022.[^1] Bitcoin uses proof-of-work.[^2][^1]',
        '',
        '[^1]: Ethereum Overview',
        '[^2]: BTC vs ETH Comparison — <https://example.com/btc-eth>',
        '',
      ].join('\n'),
    );
    expect(out.body).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    // Listed once each, cited first — not once per provenance row.
    expect(out.sourceTitles).toEqual(['Ethereum Overview', 'BTC vs ETH Comparison']);
  });

  it('names sources that left the wiki and heals legacy bodies', () => {
    handle = setupTestDb();
    const pageId = seedPage(handle.db, { title: 'Ethereum Foundation', page_type: 'entity' });
    const raw = ['```markdown', `The protocol is maintained by the Foundation (${GONE}).`, '', '## Sources', `- ${GONE}`, '```'].join(
      '\n',
    );
    const out = exportPageBody(pageId, raw, isKnownTitle);
    expect(out.body).toBe(
      ['The protocol is maintained by the Foundation[^1].', '', '[^1]: Source no longer in the wiki', ''].join('\n'),
    );
    expect(out.sourceTitles).toEqual([]);
  });

  it('leaves pages without citations as they are', () => {
    handle = setupTestDb();
    const pageId = seedPage(handle.db, { title: 'Note', page_type: 'original-source' });
    expect(exportPageBody(pageId, '---\ntitle: Note\n---\n\nJust a note.\n', isKnownTitle).body).toBe('Just a note.\n');
  });
});
