/**
 * The help under the compile-model select matches the selected model's
 * provider: the Gemini key command shows for Gemini models only.
 */

import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import ModelAccessHelp from '../app/settings/ModelAccessHelp';

const render = (provider: 'gemini' | 'deepseek' | null) =>
  renderToString(createElement(ModelAccessHelp, { provider }));

describe('ModelAccessHelp', () => {
  it('shows the Gemini model-list command for a Gemini model', () => {
    expect(render('gemini')).toContain('GEMINI_API_KEY');
  });

  it('shows nothing for a DeepSeek model, or before the setting loads', () => {
    expect(render('deepseek')).toBe('');
    expect(render(null)).toBe('');
  });
});
