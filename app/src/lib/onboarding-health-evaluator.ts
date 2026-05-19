/**
 * Pure-function evaluator for the /onboarding/health pre-stage table.
 *
 * Takes the raw /api/health JSON body and produces a stable, typed list
 * of HealthRow records — one per check the table renders. The component
 * layer maps each row to a remediation card via getRemediation(row.code).
 *
 * Severity model:
 *   - 'red'   → blocks the page's Next button.
 *   - 'amber' → informational only; Next remains enabled.
 *
 * Row contract:
 *   - nlp                → red,   coded nlp_unreachable.
 *   - selected_provider  → red,   coded selected_provider_key_missing.
 *                          Resolves which provider's key matters from
 *                          resp.selected_compile_provider.
 *   - firecrawl          → amber, coded firecrawl_key_missing.
 *   - youtube            → amber, coded youtube_key_missing.
 *
 * Provider/integration list is driven by LLM_PROVIDERS / INTEGRATION_KEYS
 * in health-providers.ts. Adding a new provider or integration is one
 * row there + a single switch arm here (mapping selected_compile_provider
 * to the right *_present field on resp.provider_keys).
 */

import { INTEGRATION_KEYS, LLM_PROVIDERS } from './health-providers';

export interface HealthApiResponse {
  status: 'ok' | 'degraded';
  nlp_ok: boolean;
  provider_keys: { gemini_present: boolean; deepseek_present: boolean };
  selected_compile_model: string;
  selected_compile_provider: 'gemini' | 'deepseek';
  integration_keys: { firecrawl_present: boolean; youtube_present: boolean };
}

export type Severity = 'red' | 'amber';

export type HealthRowId = 'nlp' | 'selected_provider' | 'firecrawl' | 'youtube';

export interface HealthRow {
  id: HealthRowId;
  severity: Severity;
  /** SERVICE_ERROR_MESSAGES key — resolves to remediation via getRemediation(). */
  code: string;
  status: 'pass' | 'fail';
  /** Table-row label (what the user sees on the left of each row). */
  label: string;
}

function resolveProviderKeyPresent(resp: HealthApiResponse): boolean {
  switch (resp.selected_compile_provider) {
    case 'gemini':
      return resp.provider_keys.gemini_present;
    case 'deepseek':
      return resp.provider_keys.deepseek_present;
    default:
      return false;
  }
}

function providerDisplayName(provider: HealthApiResponse['selected_compile_provider']): string {
  const def = LLM_PROVIDERS.find((p) => p.id === provider);
  return def?.displayName ?? provider;
}

export function evaluateHealth(resp: HealthApiResponse): HealthRow[] {
  const rows: HealthRow[] = [];

  rows.push({
    id: 'nlp',
    severity: 'red',
    code: 'nlp_unreachable',
    status: resp.nlp_ok ? 'pass' : 'fail',
    label: 'NLP service reachable',
  });

  const providerKeyPresent = resolveProviderKeyPresent(resp);
  rows.push({
    id: 'selected_provider',
    severity: 'red',
    code: 'selected_provider_key_missing',
    status: providerKeyPresent ? 'pass' : 'fail',
    label: `Selected model (${resp.selected_compile_model}) — ${providerDisplayName(resp.selected_compile_provider)} API key`,
  });

  // One amber row per INTEGRATION_KEYS entry. Switch on id to read the
  // matching boolean from resp.integration_keys — typed shape keeps this
  // exhaustive at compile time.
  for (const intg of INTEGRATION_KEYS) {
    let present = false;
    switch (intg.id) {
      case 'firecrawl':
        present = resp.integration_keys.firecrawl_present;
        break;
      case 'youtube':
        present = resp.integration_keys.youtube_present;
        break;
    }
    rows.push({
      id: intg.id,
      severity: intg.severity,
      code: `${intg.id}_key_missing`,
      status: present ? 'pass' : 'fail',
      label: `${intg.displayName} API key — ${intg.breaks}`,
    });
  }

  return rows;
}
