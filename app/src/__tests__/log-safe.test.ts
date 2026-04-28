import { describe, expect, it } from 'vitest';
import { sanitizeLogValue } from '../lib/log-safe';

describe('sanitizeLogValue', () => {
  it('passes through plain ASCII unchanged', () => {
    expect(sanitizeLogValue('abc-123')).toBe('abc-123');
  });

  it('replaces CR/LF with spaces (log-forging defence)', () => {
    expect(sanitizeLogValue('abc\nFAKE LOG')).toBe('abc FAKE LOG');
    expect(sanitizeLogValue('abc\rFAKE')).toBe('abc FAKE');
    expect(sanitizeLogValue('a\r\nb')).toBe('a  b');
  });

  it('doubles % so substitution-target strings cannot inject format specifiers', () => {
    expect(sanitizeLogValue('%s%d')).toBe('%%s%%d');
    expect(sanitizeLogValue('100%')).toBe('100%%');
  });

  it('coerces non-strings via String()', () => {
    expect(sanitizeLogValue(42)).toBe('42');
    expect(sanitizeLogValue(null)).toBe('null');
    expect(sanitizeLogValue(undefined)).toBe('undefined');
    expect(sanitizeLogValue({ a: 1 })).toBe('[object Object]');
  });

  it('handles empty string', () => {
    expect(sanitizeLogValue('')).toBe('');
  });

  it('preserves printable Unicode', () => {
    expect(sanitizeLogValue('café 👋')).toBe('café 👋');
  });
});
