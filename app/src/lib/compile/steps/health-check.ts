/**
 * Pipeline prelude step 0: health check.
 *
 * Runs as the FIRST step of any staging-based compile. Catches hard config
 * failures (NLP service down, selected-provider key missing) up front rather than
 * letting each downstream step fail in isolation with a misleading error.
 *
 * Phase 1 scope: minimal checks only. Firecrawl + selected-provider checks are
 * deferred to Slice 5 polish — a missing env var is the deterministic
 * "this will not work" signal; live reachability probes add latency +
 * flakiness for negligible catch rate over per-item failures in ingest_urls.
 */

import {
  getEffectiveCompileModel,
  getProviderForModel,
  updateCompileStep,
} from '../../db';

const NLP_SERVICE_URL = process.env.NLP_SERVICE_URL ?? 'http://nlp-service:8000';

export interface HealthReport {
  nlp_ok: boolean;
  selected_provider_key_present: boolean;
  firecrawl_key_present: boolean;
  selected_compile_provider: 'gemini' | 'deepseek';
  selected_compile_model: string;
  warnings: string[];
}

export class HealthCheckFailedError extends Error {
  constructor(public readonly code: string, message: string) {
    super(message);
    this.name = 'HealthCheckFailedError';
  }
}

/**
 * Throws HealthCheckFailedError on hard fail. Returns advisory warnings
 * in-band for soft misconfig (e.g. Firecrawl key missing while only file
 * items are staged).
 *
 * Sets compile_progress.steps.health_check to:
 *   - 'running' at start
 *   - 'failed' with detail = error code on hard fail (then throws)
 *   - 'done'   with detail summarising the report on success
 */
export async function runHealthCheckStep(
  sessionId: string,
  hasUrlItems: boolean
): Promise<HealthReport> {
  updateCompileStep(sessionId, 'health_check', 'running');

  const warnings: string[] = [];

  // 1. NLP service /health — must be reachable. spaCy model load failures
  // surface via spacy_loaded=false in the body.
  let nlp_ok = false;
  try {
    const res = await fetch(`${NLP_SERVICE_URL}/health`, {
      signal: AbortSignal.timeout(5_000),
    });
    nlp_ok = res.ok;
  } catch {
    nlp_ok = false;
  }
  if (!nlp_ok) {
    updateCompileStep(sessionId, 'health_check', 'failed', 'nlp_unreachable');
    throw new HealthCheckFailedError(
      'nlp_unreachable',
      `NLP service at ${NLP_SERVICE_URL} is unreachable. Start nlp-service before compiling.`
    );
  }

  // 2. Selected compile provider key — required for every downstream LLM step.
  const selected_compile_model = getEffectiveCompileModel(sessionId);
  const selected_compile_provider = getProviderForModel(selected_compile_model);
  const selected_provider_key_present =
    selected_compile_provider === 'deepseek'
      ?
      typeof process.env.DEEPSEEK_API_KEY === 'string' &&
        process.env.DEEPSEEK_API_KEY.length > 0
      :
      typeof process.env.GEMINI_API_KEY === 'string' &&
        process.env.GEMINI_API_KEY.length > 0;

  if (!selected_provider_key_present) {
    const missingVar =
      selected_compile_provider === 'deepseek'
        ? 'DEEPSEEK_API_KEY'
        : 'GEMINI_API_KEY';
    updateCompileStep(sessionId, 'health_check', 'failed', 'selected_provider_key_missing');
    throw new HealthCheckFailedError(
      'selected_provider_key_missing',
      `${missingVar} env var is not set. Compile model ${selected_compile_model} requires a ${selected_compile_provider.toUpperCase()} key to run.`
    );
  }

  // 3. Firecrawl key — only a hard fail when URL items are staged. Files +
  // text items don't need Firecrawl; a missing key becomes a warning there.
  const firecrawl_key_present =
    typeof process.env.FIRECRAWL_API_KEY === 'string' &&
    process.env.FIRECRAWL_API_KEY.length > 0;
  if (!firecrawl_key_present) {
    if (hasUrlItems) {
      updateCompileStep(sessionId, 'health_check', 'failed', 'firecrawl_key_missing');
      throw new HealthCheckFailedError(
        'firecrawl_key_missing',
        'FIRECRAWL_API_KEY env var is not set but URL items are staged. Set the key or discard URL items.'
      );
    } else {
      warnings.push('firecrawl_key_missing (no URL items staged — proceeding)');
    }
  }

  const report: HealthReport = {
    nlp_ok,
    selected_provider_key_present,
    selected_compile_provider,
    selected_compile_model,
    firecrawl_key_present,
    warnings,
  };
  const detail =
    warnings.length > 0 ? `ok (${warnings.length} warnings)` : 'ok';
  updateCompileStep(sessionId, 'health_check', 'done', detail);
  return report;
}
