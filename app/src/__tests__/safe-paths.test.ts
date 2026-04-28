import { describe, expect, it } from 'vitest';
import { assertSafeId, isSafeId } from '../lib/safe-paths';

describe('assertSafeId', () => {
  const validPageIds = [
    'bitcoin',
    'saved-links',
    'page-deadbeef',
    'gpt-4-page',
    'a',
    '0',
    'competes_with',
    'a'.repeat(80),
  ];

  it.each(validPageIds)('accepts valid page id %s', (id) => {
    expect(() => assertSafeId(id, 'page')).not.toThrow();
  });

  const validSourceIds = [
    '550e8400-e29b-41d4-a716-446655440000',
    'src-1-competes_with',
    'keep',
    's1',
  ];

  it.each(validSourceIds)('accepts valid source id %s', (id) => {
    expect(() => assertSafeId(id, 'source')).not.toThrow();
  });

  const invalidIds = [
    '',
    '..',
    '../etc/passwd',
    '/abs',
    'with space',
    'UPPER',
    'with.dot',
    'with/slash',
    'with\\backslash',
    '_leading-underscore',
    '-leading-hyphen',
    'a'.repeat(81),
    'page\x00id',
  ];

  it.each(invalidIds)('rejects invalid id %j', (id) => {
    expect(() => assertSafeId(id, 'page')).toThrow(TypeError);
  });

  it('rejects non-strings', () => {
    expect(() => assertSafeId(null as unknown, 'page')).toThrow(TypeError);
    expect(() => assertSafeId(42 as unknown, 'source')).toThrow(TypeError);
    expect(() => assertSafeId(undefined as unknown, 'page')).toThrow(TypeError);
  });

  it('error message names the kind', () => {
    expect(() => assertSafeId('bad..', 'source')).toThrow(/invalid_source_id/);
    expect(() => assertSafeId('bad..', 'page')).toThrow(/invalid_page_id/);
  });
});

describe('isSafeId', () => {
  it('returns true for valid', () => {
    expect(isSafeId('hello-world')).toBe(true);
  });

  it('returns false for invalid', () => {
    expect(isSafeId('../etc')).toBe(false);
    expect(isSafeId(null)).toBe(false);
  });
});
