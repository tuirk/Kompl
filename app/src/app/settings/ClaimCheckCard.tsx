'use client';

/**
 * Settings > Advanced tuning: whether each compile checks its new sources'
 * claims for disagreements with the wiki's other sources
 * (lib/compile/steps/claims.ts). On by default since it passed the accuracy
 * bar (plan 3.7); each check is a few extra AI calls. Not carried in backups.
 */

import { useEffect, useState } from 'react';

import { CLAIM_JUDGE_BATCH_SIZE, MAX_CLAIM_CHECK_PAIRS_PER_COMPILE } from '@/lib/claim-check/limits';
import { SettingCard, TogglePill } from './_ui';

const MAX_CALLS = Math.ceil(MAX_CLAIM_CHECK_PAIRS_PER_COMPILE / CLAIM_JUDGE_BATCH_SIZE);

export default function ClaimCheckCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json())
      .then((data: { claim_check_enabled?: boolean }) => setEnabled(data.claim_check_enabled !== false))
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
        body: JSON.stringify({ claim_check_enabled: next }),
      });
      if (!res.ok) throw new Error(String(res.status));
      setEnabled(next);
      setMessage('Saved — applies to the next compile.');
      setTimeout(() => setMessage(null), 2000);
    } catch {
      setMessage('Could not save. Try again.');
    } finally {
      setSaving(false);
    }
  }

  return (
    <SettingCard
      id="claim-check"
      title="Check new sources for disagreements"
      summary={
        <>
          After each compile, compares what the new sources claim with what other sources say about the same
          subjects, and flags possible disagreements on the pages for you to confirm or dismiss. Up to {MAX_CALLS}{' '}
          extra AI calls per compile.
        </>
      }
      control={
        <TogglePill
          label="Check new sources for disagreements"
          value={enabled}
          onClick={() => void toggle()}
          disabled={saving}
          defaultHint="ON"
        />
      }
      saved={message}
    />
  );
}
