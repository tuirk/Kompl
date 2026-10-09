/**
 * LLM model registry: the compile-model allowlist (server-side validation)
 * and the Settings dropdown (labels, groups) read from this one list, so the
 * two cannot drift. Client-safe on purpose: no DB or Node imports, so the
 * Settings page can import it directly. db.ts re-exports the server-facing
 * names for existing callers.
 *
 * Mirror: nlp-service/services/llm_models.py holds the same IDs as the
 * Pydantic Literal at the FastAPI boundary. Adding a model means adding it
 * there too, plus a price in that provider's _MODEL_PRICES.
 *
 * Never delete an ID. Stored settings, per-session locks
 * (compile_progress.compile_model) and old backups reference them; a
 * retired model moves to the legacy group instead.
 */

export const LLM_MODELS = [
  'deepseek-flash',
  'deepseek-v4-pro',
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-pro-preview',
  // Legacy: kept so existing settings, session locks and backups stay valid.
  'gemini-2.5-flash',
  'gemini-2.5-flash-lite',
  'gemini-2.5-pro',
  'deepseek-v4-flash',
] as const;

export type LlmModel = typeof LLM_MODELS[number];
export type LlmProvider = 'gemini' | 'deepseek';

/**
 * Model used when no compile_model setting exists. Migration v26 writes an
 * explicit row on every install (existing installs keep gemini-2.5-flash,
 * fresh ones get this value), so in practice this only applies to test
 * databases and hand-edited settings.
 */
export const DEFAULT_COMPILE_MODEL: LlmModel = 'deepseek-flash';

export interface LlmModelInfo {
  label: string;
  /** One-line summary shown under the dropdown for the selected model. */
  note: string;
  legacy: boolean;
}

export const LLM_MODEL_INFO: Record<LlmModel, LlmModelInfo> = {
  'deepseek-flash': {
    label: 'DeepSeek V4.1 Flash',
    note: 'Default. Fast and low-cost, with a 1M-token context window.',
    legacy: false,
  },
  'deepseek-v4-pro': {
    label: 'DeepSeek V4 Pro',
    note: 'Previous-generation Pro, about 4x the cost of V4.1 Flash. Validated on long academic sources (~200K characters).',
    legacy: false,
  },
  'gemini-3.8-flash': {
    label: 'Gemini 3.8 Flash',
    note: "Google's newest Flash model: strong quality at moderate cost.",
    legacy: false,
  },
  'gemini-3.5-flash-lite': {
    label: 'Gemini 3.5 Flash-Lite',
    note: 'The cheapest and fastest Gemini option.',
    legacy: false,
  },
  'gemini-3.1-pro-preview': {
    label: 'Gemini 3.1 Pro (preview)',
    note: 'The most capable Gemini model and the most expensive. Preview: Google can change or retire it at short notice.',
    legacy: false,
  },
  'gemini-2.5-flash': {
    label: 'Gemini 2.5 Flash',
    note: 'Legacy. Google only serves Gemini 2.5 to API projects that used it before.',
    legacy: true,
  },
  'gemini-2.5-flash-lite': {
    label: 'Gemini 2.5 Flash-Lite',
    note: 'Legacy. Google only serves Gemini 2.5 to API projects that used it before.',
    legacy: true,
  },
  'gemini-2.5-pro': {
    label: 'Gemini 2.5 Pro',
    note: 'Legacy. Google only serves Gemini 2.5 to API projects that used it before.',
    legacy: true,
  },
  'deepseek-v4-flash': {
    label: 'DeepSeek V4 Flash',
    note: 'Legacy. DeepSeek retired V4 Flash; Kompl sends these requests to V4.1 Flash at the same price.',
    legacy: true,
  },
};

export function isLlmModel(v: unknown): v is LlmModel {
  return typeof v === 'string' && (LLM_MODELS as readonly string[]).includes(v);
}

// Prefix dispatch matches the nlp-service factory at
// nlp-service/services/providers/__init__.py.
export function getProviderForModel(m: string): LlmProvider {
  if (m.startsWith('deepseek-')) return 'deepseek';
  return 'gemini';
}
