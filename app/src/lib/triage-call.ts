/**
 * The match step's triage call (nlp-service /pipeline/triage): does a source
 * warrant updating an existing wiki page? Used for this session's sources
 * (app/api/compile/match/route.ts) and for re-checks of stored failures
 * (lib/compile/triage-recheck.ts).
 */

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

const TRIAGE_DECISIONS: readonly string[] = ['update', 'contradiction', 'skip'];

export interface TriageResponse {
  decision: 'update' | 'contradiction' | 'skip';
  reason: string;
}

/**
 * Why a triage call gave no verdict: nlp-service's 429 and 503 answers
 * (routers/pipeline.py), or anything else (HTTP 500, timeout, unreachable).
 */
export type TriageFailure = 'llm_rate_limited' | 'daily_cost_ceiling' | 'triage_error';

export class TriageError extends Error {
  constructor(readonly failure: TriageFailure, message: string) {
    super(message);
  }
}

export function triageFailureOf(err: unknown): TriageFailure {
  return err instanceof TriageError ? err.failure : 'triage_error';
}

/** One (source, page) outcome of the match step, as plan Rule 6 reads it. */
export interface MatchEntry {
  source_id: string;
  page_id: string;
  page_title: string;
  decision: TriageResponse['decision'] | 'triage_failed';
  /** The triage's reason, or the TriageFailure when decision is 'triage_failed'. */
  reason: string;
}

export async function callTriage(
  sourceClaims: string,
  existingPageSummary: string,
  pageTitle: string,
  compileModel?: string,
): Promise<TriageResponse> {
  const res = await fetch(`${NLP_SERVICE_URL}/pipeline/triage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      source_claims: sourceClaims,
      existing_page_summary: existingPageSummary,
      page_title: pageTitle,
      ...(compileModel ? { compile_model: compileModel } : {}),
    }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!res.ok) {
    const failure: TriageFailure =
      res.status === 429 ? 'llm_rate_limited' : res.status === 503 ? 'daily_cost_ceiling' : 'triage_error';
    throw new TriageError(failure, `triage failed: ${res.status}`);
  }
  // nlp-service answers 500 for a decision the model made up; an answer
  // that still carries one is no verdict either, never a 'skip'.
  const body = (await res.json()) as TriageResponse;
  if (!TRIAGE_DECISIONS.includes(body.decision)) {
    throw new TriageError('triage_error', `triage gave an unknown decision: ${String(body.decision).slice(0, 80)}`);
  }
  return body;
}
