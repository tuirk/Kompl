'use client';

import { useEffect, useId, useState, type ReactNode } from 'react';

type Props = {
  category: string;
  pageCount: number;
  lastUpdatedLabel?: ReactNode;
  defaultOpen?: boolean;
  children: ReactNode;
};

const STORAGE_PREFIX = 'kompl_wiki_cat_open:';

export default function WikiCategorySection({
  category,
  pageCount,
  lastUpdatedLabel,
  defaultOpen = false,
  children,
}: Props) {
  const storageKey = `${STORAGE_PREFIX}${category}`;
  const [open, setOpen] = useState(defaultOpen);
  const panelId = useId();

  // After hydration, restore the section's last-session state. Absent key =>
  // first-ever visit; keep the SSR-seeded `defaultOpen` so the page isn't empty.
  useEffect(() => {
    try {
      const raw = localStorage.getItem(storageKey);
      if (raw === 'true') setOpen(true);
      else if (raw === 'false') setOpen(false);
    } catch {}
  }, [storageKey]);

  function toggle() {
    setOpen((v) => {
      const next = !v;
      try { localStorage.setItem(storageKey, String(next)); } catch {}
      return next;
    });
  }

  return (
    <section>
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        aria-controls={panelId}
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 24,
          width: '100%',
          minHeight: 68,
          padding: '16px 20px',
          background: 'var(--bg-card)',
          border: 'none',
          borderLeft: `4px solid ${open ? 'var(--accent)' : 'rgba(var(--separator-rgb), 0.3)'}`,
          cursor: 'pointer',
          color: 'inherit',
          textAlign: 'left',
          font: 'inherit',
          boxSizing: 'border-box',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, minWidth: 0 }}>
          <span
            style={{
              fontFamily: 'var(--font-heading)',
              fontWeight: 700,
              fontSize: 18,
              lineHeight: '28px',
              letterSpacing: 1.8,
              textTransform: 'uppercase',
              color: open ? 'var(--accent)' : 'var(--fg-secondary)',
              whiteSpace: 'nowrap',
            }}
          >
            {category}
          </span>
          {open ? (
            <span
              style={{
                padding: '2px 8px',
                background: 'rgba(var(--accent-rgb), 0.1)',
                border: '1px solid rgba(var(--accent-rgb), 0.2)',
                fontFamily: 'var(--font-body)',
                fontSize: 10,
                lineHeight: '15px',
                letterSpacing: 0.5,
                color: 'var(--accent)',
                whiteSpace: 'nowrap',
              }}
            >
              {pageCount} page{pageCount !== 1 ? 's' : ''}
            </span>
          ) : (
            <span
              style={{
                fontFamily: 'var(--font-body)',
                fontSize: 10,
                lineHeight: '15px',
                letterSpacing: 1,
                textTransform: 'uppercase',
                color: 'var(--fg-secondary)',
                opacity: 0.3,
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {pageCount} page{pageCount !== 1 ? 's' : ''}
            </span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 16, flexShrink: 0 }}>
          {lastUpdatedLabel ? (
            <span
              style={{
                fontFamily: 'var(--font-body)',
                fontSize: 10,
                lineHeight: '15px',
                letterSpacing: 1,
                textTransform: 'uppercase',
                color: 'var(--fg-secondary)',
                opacity: 0.3,
                whiteSpace: 'nowrap',
              }}
            >
              {lastUpdatedLabel}
            </span>
          ) : null}
          <span
            aria-hidden
            style={{
              color: 'var(--accent-dim)',
              display: 'inline-flex',
              alignItems: 'center',
            }}
          >
            <svg
              width="22"
              height="12"
              viewBox="0 0 22 12"
              fill="none"
              stroke="currentColor"
              strokeWidth="2.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <polyline points={open ? '2 10 11 2 20 10' : '2 2 11 10 20 2'} />
            </svg>
          </span>
        </div>
      </button>
      <div id={panelId} hidden={!open} style={open ? { marginTop: 16 } : undefined}>
        {children}
      </div>
    </section>
  );
}
