'use client';

/**
 * One-time notice after an upgrade that changed the writing rules
 * (lib/writing-rules.ts): some pages were written under earlier rules and can
 * be updated in Settings > Wiki health (app/settings/PageUpgradeCard.tsx).
 * Shown only while such pages exist, so a fresh install, which starts with
 * none, doesn't see it. Closing it, or following its link, records the
 * current rules (page_upgrade_notice_dismissed): it shows again only after a
 * release with new rules.
 */

import Link from 'next/link';
import { useEffect, useState } from 'react';

import { CURRENT_DRAFT_RULES } from '@/lib/writing-rules';

export default function PageUpgradeNotice() {
  const [count, setCount] = useState<number | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch('/api/wiki/page-upgrade/notice', { cache: 'no-store' })
      .then((r) => (r.ok ? (r.json() as Promise<{ show: boolean; count: number }>) : null))
      .then((data) => {
        if (!cancelled && data?.show) setCount(data.count);
      })
      .catch(() => {
        // Non-fatal: the Settings card still shows the pages.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  function dismiss() {
    setCount(null);
    void fetch('/api/wiki/page-upgrade/notice', { method: 'POST' }).catch(() => {});
  }

  if (count === null || count < 1) return null;

  return (
    <div
      role="status"
      aria-live="polite"
      style={{
        position: 'fixed',
        right: 24,
        bottom: 24,
        zIndex: 900,
        maxWidth: 380,
        display: 'flex',
        alignItems: 'flex-start',
        gap: '0.75rem',
        padding: '0.85rem 0.9rem 0.85rem 1.1rem',
        borderRadius: 8,
        border: '1px solid var(--border-hover)',
        background: 'var(--bg-card)',
        boxShadow: '0 8px 24px rgba(0, 0, 0, 0.4)',
        color: 'var(--fg-secondary)',
        fontSize: 14,
        lineHeight: 1.5,
      }}
    >
      <p style={{ margin: 0 }}>
        Kompl {CURRENT_DRAFT_RULES} improves how it writes pages. {count === 1 ? '1 page was' : `${count} pages were`}{' '}
        written by an earlier version and can be updated in{' '}
        <Link href="/settings#page-upgrade" onClick={dismiss} style={{ color: 'var(--accent)' }}>
          Settings → Wiki health
        </Link>
        .
      </p>
      <button
        type="button"
        className="btn-ghost"
        aria-label="Close this notice"
        onClick={dismiss}
        style={{ padding: '0 0.35rem', fontSize: 18, lineHeight: 1 }}
      >
        ×
      </button>
    </div>
  );
}
