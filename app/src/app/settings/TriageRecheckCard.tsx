'use client';

/**
 * Settings > Advanced tuning: whether later compiles re-check the checks of
 * a source against an existing page that failed (lib/compile/triage-recheck.ts).
 * Off by default: each re-check is an AI call. Not carried in backups.
 */

import { useEffect, useState } from 'react';

import { MAX_TRIAGE_RECHECKS_PER_COMPILE } from '@/lib/triage-recheck-limits';
import { SettingCard, TogglePill } from './_ui';

export default function TriageRecheckCard() {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json())
      .then((data: { triage_recheck_enabled?: boolean }) => setEnabled(data.triage_recheck_enabled === true))
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
        body: JSON.stringify({ triage_recheck_enabled: next }),
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
      id="triage-recheck"
      title="Retry failed page checks"
      summary={
        <>
          When checking a new source against an existing page fails (a rate limit, the daily spend cap or an error),
          later compiles try that check again, up to {MAX_TRIAGE_RECHECKS_PER_COMPILE} per compile. Each retry is an
          extra AI call.
        </>
      }
      control={
        <TogglePill
          label="Retry failed page checks"
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
