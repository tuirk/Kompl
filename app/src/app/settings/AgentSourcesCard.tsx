'use client';

/**
 * Settings > Connect your AI: whether AI agents may add sources through the
 * MCP add_source tool (lib/agent-sources.ts). Off by default. Each added
 * source starts a compile, which uses the AI model, so the card says so and
 * states the limits. The switch is not carried in backups.
 */

import { useEffect, useState } from 'react';

import { MAX_PER_CALL, MAX_PER_DAY } from '@/lib/agent-sources-limits';
import { codeStyle, SettingCard, TogglePill } from './_ui';

export default function AgentSourcesCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json())
      .then((data: { agent_add_sources_enabled?: boolean }) => setEnabled(data.agent_add_sources_enabled === true))
      .catch(() => setMessage('Could not load this setting.'));
  }, []);

  async function toggle() {
    if (enabled === null) return;
    const next = !enabled;
    setSaving(true);
    setMessage(null);
    try {
      const res = await fetch('/api/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agent_add_sources_enabled: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setEnabled(next);
      setMessage('Saved.');
      setTimeout(() => setMessage(null), 2000);
    } catch {
      setMessage('Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingCard
      id="agent-sources"
      title="Let AI agents add sources"
      summary={
        <>
          Your agent can save links or notes to Kompl with the <code style={codeStyle}>add_source</code> tool. Each addition starts a
          compile, which uses your AI model and counts toward your daily spend cap. Agents can add up to {MAX_PER_CALL}{' '}
          sources at a time and {MAX_PER_DAY} a day, and every addition appears in the activity feed with the agent&apos;s
          name. With auto-approve off, the new pages wait for your review as drafts.
        </>
      }
      control={
        <TogglePill
          label="Let AI agents add sources"
          value={enabled}
          onClick={() => void toggle()}
          disabled={saving}
          defaultHint="OFF"
        />
      }
      saved={message}
    />
  );
}
