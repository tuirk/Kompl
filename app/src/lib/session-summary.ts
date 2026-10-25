/**
 * The plain-words line the sessions list (/sessions) shows for a compile
 * session, instead of its internal step key ("at schema", "at ingest_urls").
 * Step names come from the compile step registry (lib/compile-steps.ts).
 */

import { COMPILE_STEP_LABELS } from './compile-steps';

export interface SessionLineInput {
  status: string;
  current_step: string | null;
  error: string | null;
}

/** The step's label, or its key in words for a step this version doesn't know. */
export function stepName(key: string): string {
  return (COMPILE_STEP_LABELS as Record<string, string>)[key] ?? key.replace(/_/g, ' ');
}

export function sessionLine(s: SessionLineInput): string {
  const step = s.current_step ? stepName(s.current_step) : null;
  switch (s.status) {
    case 'completed':
      return 'All steps done';
    case 'queued':
      return 'Waiting to start';
    case 'running':
      return step ? `Now: ${step}` : 'Starting';
    case 'cancelled':
      return step ? `Cancelled during: ${step}` : 'Cancelled';
    case 'failed': {
      const where = step ? `Failed during: ${step}` : 'Failed';
      return s.error ? `${where}. ${s.error}` : where;
    }
    default:
      return step ? `Step: ${step}` : '';
  }
}
