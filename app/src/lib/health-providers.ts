/**
 * Provider-agnostic registry of LLM providers and ingest integrations.
 *
 * Adding a new LLM provider or integration is one row in the relevant array.
 * Consumed by:
 *   - /api/health route (Phase 2): emits one boolean per envKey in
 *     provider_keys / integration_keys.
 *   - onboarding-health-evaluator (Phase 3): generates one HealthRow per
 *     entry, mapped to a SERVICE_ERROR_MESSAGES code on failure.
 *
 * Severity policy:
 *   - LLM_PROVIDERS rows are checked per-session (only the *selected*
 *     compile model's provider is gated). The check is red.
 *   - INTEGRATION_KEYS rows are always amber. A missing ingest key fails
 *     specific item types (URLs, YouTube URLs) but does not block compile
 *     start — the user's prerogative to skip those item types.
 */

export interface LlmProviderDef {
  /** Stable identifier; matches getProviderForModel() output in db.ts. */
  id: 'gemini' | 'deepseek';
  /** Env var name read by both the app and nlp-service containers. */
  envKey: 'GEMINI_API_KEY' | 'DEEPSEEK_API_KEY';
  /** User-facing label rendered in the health table. */
  displayName: string;
}

export interface IntegrationDef {
  /** Stable identifier; matches the `${id}_key_missing` code in service-errors.ts. */
  id: 'firecrawl' | 'youtube';
  /** Env var name read by nlp-service. */
  envKey: 'FIRECRAWL_API_KEY' | 'YOUTUBE_API_KEY';
  /** Always amber — missing key gates specific ingest paths, not compile start. */
  severity: 'amber';
  /** One-line description of what fails when the key is missing. */
  breaks: string;
  /** User-facing label rendered in the health table. */
  displayName: string;
}

export const LLM_PROVIDERS: readonly LlmProviderDef[] = [
  { id: 'gemini',   envKey: 'GEMINI_API_KEY',   displayName: 'Gemini' },
  { id: 'deepseek', envKey: 'DEEPSEEK_API_KEY', displayName: 'DeepSeek' },
] as const;

export const INTEGRATION_KEYS: readonly IntegrationDef[] = [
  {
    id: 'firecrawl',
    envKey: 'FIRECRAWL_API_KEY',
    severity: 'amber',
    breaks: 'URL ingest (web pages)',
    displayName: 'Firecrawl',
  },
  {
    id: 'youtube',
    envKey: 'YOUTUBE_API_KEY',
    severity: 'amber',
    breaks: 'YouTube URL ingest',
    displayName: 'YouTube',
  },
] as const;
