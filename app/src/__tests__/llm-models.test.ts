/**
 * Model registry guards (lib/llm-models.ts).
 *
 *   - Every model ID that ever shipped stays valid: stored settings,
 *     per-session locks and old backups reference them, so deleting one
 *     would silently move existing installs to the default model.
 *   - The app allowlist and the nlp-service Pydantic Literal list the same
 *     IDs, so a model the Settings page offers is never rejected with a 422.
 */

import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import {
  LLM_MODELS,
  LLM_MODEL_INFO,
  DEFAULT_COMPILE_MODEL,
  isLlmModel,
  getProviderForModel,
} from '../lib/llm-models';

const EVER_SHIPPED = [
  'gemini-2.5-flash-lite',
  'gemini-2.5-flash',
  'gemini-2.5-pro',
  'deepseek-v4-pro',
  'deepseek-v4-flash',
  'deepseek-flash',
  'gemini-3.8-flash',
  'gemini-3.5-flash-lite',
  'gemini-3.1-pro-preview',
];

describe('LLM model registry', () => {
  it('keeps every model ID that ever shipped', () => {
    for (const id of EVER_SHIPPED) expect(isLlmModel(id)).toBe(true);
  });

  it('defaults to a current (non-legacy) model', () => {
    expect(isLlmModel(DEFAULT_COMPILE_MODEL)).toBe(true);
    expect(LLM_MODEL_INFO[DEFAULT_COMPILE_MODEL].legacy).toBe(false);
  });

  it('rejects unknown and non-string values', () => {
    expect(isLlmModel('gpt-4o')).toBe(false);
    expect(isLlmModel('')).toBe(false);
    expect(isLlmModel(undefined)).toBe(false);
  });

  it('routes models to providers by prefix', () => {
    expect(getProviderForModel('deepseek-flash')).toBe('deepseek');
    expect(getProviderForModel('deepseek-v4-pro')).toBe('deepseek');
    expect(getProviderForModel('gemini-3.8-flash')).toBe('gemini');
  });

  it('matches the nlp-service allowlist exactly', () => {
    const pyPath = path.resolve(__dirname, '../../../nlp-service/services/llm_models.py');
    const py = fs.readFileSync(pyPath, 'utf-8');
    const block = py.match(/LLMModel = Literal\[([\s\S]*?)\]/);
    expect(block).not.toBeNull();
    const pyIds = [...block![1].matchAll(/"([^"]+)"/g)].map((m) => m[1]).sort();
    expect(pyIds).toEqual([...LLM_MODELS].sort());
  });
});
