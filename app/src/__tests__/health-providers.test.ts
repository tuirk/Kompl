import { describe, expect, it } from 'vitest';
import {
  INTEGRATION_KEYS,
  LLM_PROVIDERS,
  type IntegrationDef,
  type LlmProviderDef,
} from '../lib/health-providers';

describe('LLM_PROVIDERS', () => {
  it('includes gemini with GEMINI_API_KEY', () => {
    const gemini = LLM_PROVIDERS.find((p) => p.id === 'gemini');
    expect(gemini).toBeDefined();
    expect(gemini!.envKey).toBe('GEMINI_API_KEY');
    expect(gemini!.displayName.length).toBeGreaterThan(0);
  });

  it('includes deepseek with DEEPSEEK_API_KEY', () => {
    const deepseek = LLM_PROVIDERS.find((p) => p.id === 'deepseek');
    expect(deepseek).toBeDefined();
    expect(deepseek!.envKey).toBe('DEEPSEEK_API_KEY');
    expect(deepseek!.displayName.length).toBeGreaterThan(0);
  });

  it('every id maps to a unique provider', () => {
    const ids = LLM_PROVIDERS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('shape satisfies LlmProviderDef at the type level', () => {
    const sample: LlmProviderDef = LLM_PROVIDERS[0];
    expect(typeof sample.id).toBe('string');
    expect(typeof sample.envKey).toBe('string');
    expect(typeof sample.displayName).toBe('string');
  });
});

describe('INTEGRATION_KEYS', () => {
  it('includes firecrawl with FIRECRAWL_API_KEY and amber severity', () => {
    const fc = INTEGRATION_KEYS.find((k) => k.id === 'firecrawl');
    expect(fc).toBeDefined();
    expect(fc!.envKey).toBe('FIRECRAWL_API_KEY');
    expect(fc!.severity).toBe('amber');
    expect(fc!.breaks.length).toBeGreaterThan(0);
    expect(fc!.displayName.length).toBeGreaterThan(0);
  });

  it('includes youtube with YOUTUBE_API_KEY and amber severity', () => {
    const yt = INTEGRATION_KEYS.find((k) => k.id === 'youtube');
    expect(yt).toBeDefined();
    expect(yt!.envKey).toBe('YOUTUBE_API_KEY');
    expect(yt!.severity).toBe('amber');
    expect(yt!.breaks.length).toBeGreaterThan(0);
    expect(yt!.displayName.length).toBeGreaterThan(0);
  });

  it('every id maps to a unique integration', () => {
    const ids = INTEGRATION_KEYS.map((k) => k.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('shape satisfies IntegrationDef at the type level', () => {
    const sample: IntegrationDef = INTEGRATION_KEYS[0];
    expect(typeof sample.id).toBe('string');
    expect(typeof sample.envKey).toBe('string');
    expect(sample.severity).toBe('amber');
  });
});
