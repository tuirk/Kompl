'use client';

/**
 * Presentational building blocks for /settings. Every setting renders as a
 * SettingCard: title, a short always-visible summary, optional longer help
 * behind a native <details> toggle (browser find-in-page still searches and
 * opens it), the control on the right and an inline "Saved" bar.
 */

import { useEffect, useState, type CSSProperties, type ReactNode } from 'react';

const cardStyle: CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 8,
  overflow: 'hidden',
  scrollMarginTop: '80px',
};

const groupHeadingStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: 11,
  textTransform: 'uppercase',
  letterSpacing: '1.5px',
  color: 'var(--fg-dim)',
  margin: '0 0 0.4rem',
  fontWeight: 600,
  // Clears the fixed 65px TopNav when a #section link scrolls here.
  scrollMarginTop: '80px',
};

export const codeStyle: CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '0.78rem',
  color: 'var(--fg-secondary)',
};

export const preStyle: CSSProperties = {
  margin: 0,
  padding: '0.6rem 0.85rem',
  background: 'var(--bg-card)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  color: 'var(--fg)',
  fontFamily: 'var(--font-mono)',
  fontSize: '0.8rem',
  overflowX: 'auto',
  whiteSpace: 'pre',
};

export function SettingsGroup({
  id,
  title,
  intro,
  first = false,
  children,
}: {
  id: string;
  title: string;
  intro?: ReactNode;
  first?: boolean;
  children: ReactNode;
}) {
  return (
    <section style={{ marginTop: first ? 0 : '2.75rem' }}>
      <h2 id={id} data-settings-group style={groupHeadingStyle}>{title}</h2>
      {intro && (
        <p style={{ margin: '0 0 1rem', fontSize: '0.85rem', color: 'var(--fg-dim)', lineHeight: 1.5 }}>
          {intro}
        </p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: '1rem', marginTop: intro ? 0 : '0.6rem' }}>
        {children}
      </div>
    </section>
  );
}

export function SettingCard({
  id,
  title,
  badge,
  summary,
  details,
  control,
  footer,
  saved,
  children,
}: {
  id?: string;
  title: string;
  badge?: string;
  summary: ReactNode;
  details?: ReactNode;
  control?: ReactNode;
  /** Extra content shown full-width under the header row (still inside the card). */
  footer?: ReactNode;
  /** Message for the green confirmation bar; null hides it. */
  saved?: string | null;
  children?: ReactNode;
}) {
  return (
    <div id={id} style={cardStyle}>
      <div
        style={{
          padding: '1.25rem 1.5rem',
          display: 'flex',
          alignItems: 'flex-start',
          justifyContent: 'space-between',
          gap: '1.5rem',
          flexWrap: 'wrap',
        }}
      >
        <div style={{ flex: '1 1 340px', minWidth: 0 }}>
          <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: '0.35rem', display: 'flex', alignItems: 'center', gap: 8 }}>
            {title}
            {badge && <Badge>{badge}</Badge>}
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', lineHeight: 1.55 }}>{summary}</div>
          {details && <Details>{details}</Details>}
        </div>
        {control && <div style={{ flexShrink: 0 }}>{control}</div>}
      </div>
      {footer && <div style={{ padding: '0 1.5rem 1.25rem' }}>{footer}</div>}
      {children}
      {saved && <SavedBar>{saved}</SavedBar>}
    </div>
  );
}

/** Bare card shell for layouts SettingCard doesn't fit (e.g. the advanced group). */
export function Card({ id, children }: { id?: string; children: ReactNode }) {
  return <div id={id} style={cardStyle}>{children}</div>;
}

/** A row inside a multi-setting card (used by the advanced tuning group). */
export function SettingRow({
  title,
  summary,
  control,
  first = false,
}: {
  title: string;
  summary: ReactNode;
  control: ReactNode;
  first?: boolean;
}) {
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'flex-start',
        justifyContent: 'space-between',
        gap: '1.5rem',
        flexWrap: 'wrap',
        paddingTop: first ? 0 : '1rem',
        marginTop: first ? 0 : '1rem',
        borderTop: first ? 'none' : '1px solid var(--border)',
      }}
    >
      <div style={{ flex: '1 1 340px', minWidth: 0 }}>
        <div style={{ fontSize: '0.9rem', fontWeight: 500, marginBottom: '0.3rem' }}>{title}</div>
        <div style={{ fontSize: '0.82rem', color: 'var(--fg-muted)', lineHeight: 1.55 }}>{summary}</div>
      </div>
      <div style={{ flexShrink: 0 }}>{control}</div>
    </div>
  );
}

export function Details({ label = 'Details', children }: { label?: string; children: ReactNode }) {
  return (
    <details style={{ marginTop: '0.55rem' }}>
      <summary style={{ cursor: 'pointer', fontSize: '0.8rem', color: 'var(--accent)', width: 'fit-content' }}>
        {label}
      </summary>
      <div style={{ marginTop: '0.55rem', fontSize: '0.83rem', color: 'var(--fg-muted)', lineHeight: 1.6 }}>
        {children}
      </div>
    </details>
  );
}

export function Badge({ children }: { children: ReactNode }) {
  return (
    <span
      style={{
        padding: '1px 6px',
        fontSize: '0.65rem',
        fontWeight: 700,
        letterSpacing: '0.08em',
        textTransform: 'uppercase',
        background: 'rgba(var(--warning-rgb), 0.1)',
        border: '1px solid rgba(var(--warning-rgb), 0.25)',
        color: 'var(--warning)',
        borderRadius: 4,
      }}
    >
      {children}
    </span>
  );
}

export function SavedBar({ children }: { children: ReactNode }) {
  return (
    <div
      role="status"
      style={{
        padding: '0.6rem 1.5rem',
        background: 'var(--success-bg, #ecfdf5)',
        borderTop: '1px solid var(--success-border, #a7f3d0)',
        color: 'var(--success, #059669)',
        fontSize: 13,
      }}
    >
      {children}
    </div>
  );
}

/** ON/OFF pill used by boolean settings. */
export function TogglePill({
  value,
  onClick,
  disabled,
  label,
  defaultHint,
}: {
  value: boolean | null;
  onClick: () => void;
  disabled: boolean;
  label: string;
  defaultHint?: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <button
        type="button"
        className={value ? undefined : 'btn-outline'}
        onClick={onClick}
        disabled={value === null || disabled}
        aria-pressed={value ?? undefined}
        aria-label={label}
        style={{
          padding: '0.45rem 1rem',
          borderRadius: 20,
          fontSize: '0.85rem',
          opacity: value === null ? 0.5 : 1,
          minWidth: 80,
        }}
      >
        {value === null ? '…' : value ? 'ON' : 'OFF'}
      </button>
      {defaultHint && <DefaultHint>{defaultHint}</DefaultHint>}
    </div>
  );
}

function DefaultHint({ children }: { children: ReactNode }) {
  return (
    <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)', letterSpacing: '0.3px' }}>
      Default: {children}
    </span>
  );
}

/** Number input with unit label and a "Default: …" hint underneath. */
export function NumberField({
  value,
  onChange,
  onBlur,
  disabled,
  min,
  step,
  unit,
  prefix,
  width = 80,
  defaultHint,
  label,
}: {
  value: number | null;
  onChange: (raw: string) => void;
  onBlur: () => void;
  disabled: boolean;
  min: number;
  step: number;
  unit?: string;
  prefix?: string;
  width?: number;
  defaultHint?: string;
  label: string;
}) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', gap: 4 }}>
      <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
        {prefix && <span style={{ fontSize: '0.85rem', color: 'var(--fg-dim)' }}>{prefix}</span>}
        <input
          type="number"
          aria-label={label}
          min={min}
          step={step}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          onBlur={onBlur}
          disabled={value === null || disabled}
          style={{
            width,
            padding: '0.45rem 0.6rem',
            borderRadius: 6,
            border: '1px solid var(--border)',
            background: 'var(--bg-card)',
            color: 'var(--fg)',
            fontSize: '0.9rem',
            textAlign: 'right',
            opacity: value === null ? 0.5 : 1,
          }}
        />
        {unit && <span style={{ fontSize: '0.85rem', color: 'var(--fg-dim)' }}>{unit}</span>}
      </div>
      {defaultHint && <DefaultHint>{defaultHint}</DefaultHint>}
    </div>
  );
}

/**
 * Sticky "On this page" nav. Highlights the last group whose heading has
 * scrolled past the top of the viewport (or the last group once the page is
 * scrolled to the bottom). Recomputed on scroll, resize and hash changes, so
 * direct jumps like /settings#integrations highlight the right entry too.
 */
export function SettingsNav({ items }: { items: ReadonlyArray<{ id: string; label: string }> }) {
  const [active, setActive] = useState<string>(items[0]?.id ?? '');

  useEffect(() => {
    const ids = items.map((i) => i.id);
    if (ids.length === 0) return;
    let frame = 0;

    function update() {
      frame = 0;
      // A group counts as "current" once its heading is in the top 40% of
      // the viewport.
      const threshold = window.innerHeight * 0.4;
      let current = ids[0];
      for (const id of ids) {
        const el = document.getElementById(id);
        if (el && el.getBoundingClientRect().top <= threshold) current = id;
      }
      // At the end of the page the last headings can't scroll that far. Prefer
      // the group holding an anchor target that is on screen (e.g. #import),
      // otherwise the last group.
      const atBottom =
        window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4;
      if (atBottom) {
        const target = location.hash
          ? document.getElementById(decodeURIComponent(location.hash.slice(1)))
          : null;
        const top = target?.getBoundingClientRect().top;
        const onScreen = top !== undefined && top >= 0 && top < window.innerHeight;
        const targetGroup = onScreen
          ? target?.closest('section')?.querySelector('h2[data-settings-group]')?.id
          : undefined;
        current = targetGroup ?? ids[ids.length - 1];
      }
      setActive(current);
    }
    function schedule() {
      if (!frame) frame = requestAnimationFrame(update);
    }

    update();
    window.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    window.addEventListener('hashchange', schedule);
    return () => {
      window.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      window.removeEventListener('hashchange', schedule);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [items]);

  return (
    <nav
      aria-label="Settings sections"
      style={{
        position: 'sticky',
        // Below the fixed 65px TopNav, so the label never slides under it.
        top: 88,
        width: 180,
        flexShrink: 0,
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '1px',
          color: 'var(--fg-dim)',
          marginBottom: 8,
        }}
      >
        On this page
      </div>
      {items.map((item) => {
        const isActive = item.id === active;
        return (
          <a
            key={item.id}
            href={`#${item.id}`}
            aria-current={isActive ? 'location' : undefined}
            onClick={() => setActive(item.id)}
            style={{
              fontSize: '0.85rem',
              color: isActive ? 'var(--fg)' : 'var(--fg-secondary)',
              fontWeight: isActive ? 600 : 400,
              textDecoration: 'none',
              padding: '0.4rem 0 0.4rem 0.75rem',
              borderLeft: `2px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
              transition: 'color var(--transition-fast), border-color var(--transition-fast)',
            }}
          >
            {item.label}
          </a>
        );
      })}
    </nav>
  );
}
