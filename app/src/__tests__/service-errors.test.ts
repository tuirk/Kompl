import { describe, expect, it } from 'vitest';
import { getRemediation, toUserMessage } from '../lib/service-errors';

describe('toUserMessage — back-compat shim', () => {
  it('returns the title string for a known code (nlp_unreachable)', () => {
    const msg = toUserMessage('nlp_unreachable');
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
    expect(msg).toMatch(/NLP/i);
  });

  it('returns the title string for n8n_unreachable', () => {
    const msg = toUserMessage('n8n_unreachable');
    expect(typeof msg).toBe('string');
    expect(msg).toMatch(/n8n/i);
  });

  it('falls back to default for unknown code', () => {
    expect(toUserMessage('totally_unknown_code')).toBe('Something went wrong');
  });

  it('falls back to custom fallback for unknown code', () => {
    expect(toUserMessage('totally_unknown_code', 'custom fallback')).toBe('custom fallback');
  });
});

describe('getRemediation', () => {
  it('returns { title, body, fix } for nlp_unreachable', () => {
    const r = getRemediation('nlp_unreachable');
    expect(r).toBeDefined();
    expect(typeof r!.title).toBe('string');
    expect(typeof r!.body).toBe('string');
    expect(typeof r!.fix).toBe('string');
    expect(r!.title.length).toBeGreaterThan(0);
    expect(r!.body.length).toBeGreaterThan(0);
    expect(r!.fix.length).toBeGreaterThan(0);
  });

  it('returns undefined for unknown code', () => {
    expect(getRemediation('totally_unknown_code')).toBeUndefined();
  });
});
