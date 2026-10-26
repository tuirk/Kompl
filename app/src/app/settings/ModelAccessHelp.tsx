/**
 * Help under the compile-model select, for the selected model's provider
 * only. Gemini keys differ in which models they may call, so a Gemini model
 * gets the command that lists them. That command means nothing for a
 * DeepSeek model, so a DeepSeek model shows no help here.
 */

import type { LlmProvider } from '@/lib/llm-models';
import { CodeBlock } from './_ui';

export default function ModelAccessHelp({ provider }: { provider: LlmProvider | null }) {
  if (provider !== 'gemini') return null;
  return (
    <>
      <div style={{ fontSize: '0.82rem', color: 'var(--fg-muted)', lineHeight: 1.5, marginBottom: '0.4rem' }}>
        Not every Gemini API key has access to every model. To list what your key can use, run:
      </div>
      <CodeBlock label="Command to list your key's Gemini models">{`curl -s -H "x-goog-api-key: $GEMINI_API_KEY" https://generativelanguage.googleapis.com/v1beta/models | jq '.models[].name'`}</CodeBlock>
    </>
  );
}
