'use client';

import { useId, useState, type ReactNode } from 'react';

type Props = {
  category: string;
  pageCount: number;
  children: ReactNode;
};

export default function WikiCategorySection({ category, pageCount, children }: Props) {
  const [open, setOpen] = useState(false);
  const panelId = useId();

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        style={{
          display: 'flex',
          flexDirection: 'row',
          alignItems: 'center',
          gap: 16,
          marginBottom: open ? 24 : 0,
          width: '100%',
          padding: 0,
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          color: 'inherit',
          textAlign: 'left',
          font: 'inherit',
        }}
      >
        <span
          aria-hidden
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: 12,
            lineHeight: '20px',
            color: 'var(--fg-dim)',
            width: 12,
            flexShrink: 0,
          }}
        >
          {open ? '▾' : '▸'}
        </span>
        <span
          style={{
            fontFamily: 'var(--font-heading)',
            fontWeight: 700,
            fontSize: 14,
            lineHeight: '20px',
            letterSpacing: 3.5,
            textTransform: 'uppercase',
            color: 'var(--fg)',
            whiteSpace: 'nowrap',
          }}
        >
          {category}
          <span style={{ color: 'var(--fg-dim)', marginLeft: 12, letterSpacing: 1 }}>
            · {pageCount}
          </span>
        </span>
        <div
          style={{
            flex: 1,
            height: 1,
            background:
              'linear-gradient(90deg, rgba(var(--separator-rgb),0.3) 0%, rgba(var(--separator-rgb),0) 100%)',
          }}
        />
      </button>

      <div id={panelId} hidden={!open}>
        {children}
      </div>
    </section>
  );
}
