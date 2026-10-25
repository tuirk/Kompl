/**
 * The sessions list says what happened in plain words, never a step key.
 */

import { describe, expect, it } from 'vitest';
import { sessionLine } from '../lib/session-summary';

describe('sessionLine', () => {
  it('names steps by their label, not their key', () => {
    expect(sessionLine({ status: 'completed', current_step: 'schema', error: null })).toBe('All steps done');
    expect(sessionLine({ status: 'cancelled', current_step: 'ingest_urls', error: null })).toBe(
      'Cancelled during: Fetching URLs',
    );
    expect(sessionLine({ status: 'running', current_step: 'resolve', error: null })).toBe('Now: Resolving entities');
    expect(sessionLine({ status: 'queued', current_step: null, error: null })).toBe('Waiting to start');
  });

  it('puts the failed step before the error', () => {
    expect(sessionLine({ status: 'failed', current_step: 'health_check', error: 'NLP service is unreachable.' })).toBe(
      'Failed during: Checking services. NLP service is unreachable.',
    );
  });

  it('writes an unknown step key in words', () => {
    expect(sessionLine({ status: 'cancelled', current_step: 'old_step', error: null })).toBe(
      'Cancelled during: old step',
    );
  });
});
