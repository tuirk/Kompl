/**
 * A source's publication date (plan 3.2, D5; lib/source-dates.ts): the
 * source's own metadata first, then a tweet's date, then a date the text
 * gives near its top, else the day it was added, with the origin recorded.
 * Sources added before read as their ingest day.
 */

import { describe, expect, it } from 'vitest';
import { dateInText, pickSourceDate, sourceDateOf } from '../lib/source-dates';

const NOW = new Date('2026-10-24T12:00:00Z');

describe('dateInText', () => {
  it.each([
    ['*By Ana Ribeiro · Published March 5, 2024*\n\nText.', '2024-03-05'],
    ['Posted on 5th Mar 2024 by admin', '2024-03-05'],
    ['**Published:** 2023-11-02T15:00:00Z', '2023-11-02'],
    ['Date: 2021/07/09', '2021-07-09'],
    ['Last updated: Sep 1, 2025', '2025-09-01'],
    ['# Night trams\n\nMar 5, 2024 · 5 min read\n\nBody.', '2024-03-05'],
  ])('finds the date in %j', (text, want) => {
    expect(dateInText(text, NOW)).toBe(want);
  });

  it('prefers a published date over an updated one, wherever they stand', () => {
    expect(dateInText('Updated June 1, 2025. Published January 2, 2024.', NOW)).toBe('2024-01-02');
  });

  it('never takes a date from running prose, a far-down line, or an impossible day', () => {
    const prose =
      'On July 20, 1969, Apollo 11 landed on the Moon, and the crew spent about twenty-one hours on the surface before leaving.';
    expect(dateInText(prose, NOW)).toBeNull();
    expect(dateInText(`${'Filler line of text.\n'.repeat(200)}Published March 5, 2024`, NOW)).toBeNull();
    expect(dateInText('Published February 30, 2024', NOW)).toBeNull();
    expect(dateInText('Published March 5, 2099', NOW)).toBeNull();
    expect(dateInText('The dismay 5, 2024 meeting', NOW)).toBeNull();
  });
});

describe('pickSourceDate', () => {
  const base = { source_type: 'url', markdown: 'Published March 5, 2024', now: NOW };

  it("takes conversion's metadata date first, with its origin", () => {
    expect(
      pickSourceDate({ ...base, converted: { published_at: '2023-01-15', published_at_source: 'file_metadata' } })
    ).toEqual({ published_at: '2023-01-15', published_at_source: 'file_metadata' });
  });

  it('ignores an unknown origin or a malformed date from conversion', () => {
    for (const converted of [
      { published_at: '2023-01-15', published_at_source: 'guess' },
      { published_at: 'soon', published_at_source: 'youtube' },
      { published_at: null, published_at_source: null },
    ]) {
      expect(pickSourceDate({ ...base, converted })).toEqual({ published_at: '2024-03-05', published_at_source: 'source_text' });
    }
  });

  it("takes a tweet's own date, then the text, then the day it was added", () => {
    expect(
      pickSourceDate({ ...base, source_type: 'tweet', metadata: { date_saved: '2022-08-01T10:00:00.000Z' } })
    ).toEqual({ published_at: '2022-08-01', published_at_source: 'tweet' });
    // A bookmark's date_saved is when it was saved, not published.
    expect(
      pickSourceDate({ ...base, metadata: { date_saved: '2022-08-01T10:00:00.000Z' } })
    ).toEqual({ published_at: '2024-03-05', published_at_source: 'source_text' });
    expect(pickSourceDate({ ...base, markdown: 'No dates here.' })).toEqual({
      published_at: '2026-10-24',
      published_at_source: 'ingested',
    });
  });
});

describe('sourceDateOf', () => {
  it('reads a stored date, and an older source as its ingest day', () => {
    expect(
      sourceDateOf({ published_at: '2024-03-05', published_at_source: 'page_published', date_ingested: '2026-01-01 10:00:00' })
    ).toEqual({ published_at: '2024-03-05', published_at_source: 'page_published' });
    expect(sourceDateOf({ published_at: null, published_at_source: null, date_ingested: '2026-01-01 10:00:00' })).toEqual({
      published_at: '2026-01-01',
      published_at_source: 'ingested',
    });
    expect(sourceDateOf({ date_ingested: null })).toBeNull();
    // A malformed stored value or an unknown origin reads as the ingest day too.
    for (const bad of [{ published_at: 'soon', published_at_source: 'page_published' }, { published_at: '2024-03-05', published_at_source: 'guess' }]) {
      expect(sourceDateOf({ ...bad, date_ingested: '2026-01-01 10:00:00' })).toEqual({
        published_at: '2026-01-01',
        published_at_source: 'ingested',
      });
    }
  });
});
