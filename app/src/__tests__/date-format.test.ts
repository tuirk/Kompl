/**
 * The shared date and time format (lib/date-format.ts): one format on every
 * screen, local time, database timestamps read as UTC, bare dates never
 * shifted by a time zone.
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { formatDate, formatDateTime, formatTime, parseTimestamp } from '../lib/date-format';

let savedTz: string | undefined;

beforeEach(() => {
  savedTz = process.env.TZ;
  // UTC+3 in October: the time zone of the owner's screenshots.
  process.env.TZ = 'Europe/Vilnius';
});

afterEach(() => {
  if (savedTz === undefined) delete process.env.TZ;
  else process.env.TZ = savedTz;
});

describe('date-format', () => {
  it('reads database timestamps as UTC and shows them in local time', () => {
    expect(formatDateTime('2026-10-10 10:51:34')).toBe('10 Oct 2026, 13:51');
    expect(formatDate('2026-10-10 22:30:00')).toBe('11 Oct 2026');
    expect(formatTime('2026-10-10 10:51:34')).toBe('13:51');
    expect(formatTime('2026-10-10 10:51:34', { seconds: true })).toBe('13:51:34');
  });

  it('reads ISO strings with a zone as written', () => {
    expect(formatDateTime('2026-10-10T10:51:34.123Z')).toBe('10 Oct 2026, 13:51');
    expect(formatDateTime('2026-10-10T10:51:34+02:00')).toBe('10 Oct 2026, 11:51');
  });

  it('shows the UTC reading on request (server render)', () => {
    expect(formatDateTime('2026-10-10 10:51:34', { utc: true })).toBe('10 Oct 2026, 10:51');
  });

  it('never shifts a bare calendar date', () => {
    process.env.TZ = 'America/Los_Angeles';
    expect(formatDate('2026-03-01')).toBe('1 Mar 2026');
  });

  it('returns unreadable input unchanged', () => {
    expect(formatDate('soon')).toBe('soon');
    expect(formatDateTime('')).toBe('');
    expect(parseTimestamp('not a date')).toBeNull();
  });
});
