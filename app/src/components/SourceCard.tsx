'use client';

/**
 * Onboarding card used on the home page.
 *
 * Two visual modes:
 *   - "active"       — normal interactive card; children render inline below
 *                      the title (e.g. a textarea or file input).
 *   - "coming-soon"  — muted; whole card is clickable, clicking fires
 *                      onClick (parent shows a toast).
 */

import type { ReactNode } from 'react';

export interface SourceCardProps {
  icon: string;
  title: string;
  description: string;
  status: 'active' | 'coming-soon';
  onClick?: () => void;
  children?: ReactNode;
}

export function SourceCard({ icon, title, description, status, onClick, children }: SourceCardProps) {
  const isComingSoon = status === 'coming-soon';

  return (
    <div
      onClick={isComingSoon ? onClick : undefined}
      role={isComingSoon ? 'button' : undefined}
      tabIndex={isComingSoon ? 0 : undefined}
      onKeyDown={
        isComingSoon
          ? (e) => {
              if (e.key === 'Enter' || e.key === ' ') onClick?.();
            }
          : undefined
      }
      style={{
        background: 'var(--bg-card)',
        border: '1px solid var(--border)',
        borderRadius: 10,
        padding: '1.2rem 1.3rem',
        cursor: isComingSoon ? 'pointer' : 'default',
        opacity: isComingSoon ? 0.65 : 1,
        transition: 'border-color 120ms, background 120ms, opacity 120ms',
        display: 'flex',
        flexDirection: 'column',
        gap: '0.5rem',
      }}
      onMouseEnter={(e) => {
        if (isComingSoon) {
          (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border-hover)';
        }
      }}
      onMouseLeave={(e) => {
        if (isComingSoon) {
          (e.currentTarget as HTMLDivElement).style.borderColor = 'var(--border)';
        }
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: '0.55rem' }}>
        <span aria-hidden style={{ fontSize: '1.25rem' }}>
          {icon}
        </span>
        <h3 style={{ margin: 0, fontSize: '1.05rem', fontWeight: 600 }}>{title}</h3>
        {isComingSoon && (
          <span
            style={{
              marginLeft: 'auto',
              fontSize: '0.7rem',
              color: 'var(--fg-muted)',
              border: '1px solid var(--border-hover)',
              padding: '0.1em 0.55em',
              borderRadius: 999,
              textTransform: 'uppercase',
              letterSpacing: '0.05em',
            }}
          >
            soon
          </span>
        )}
      </div>
      <p style={{ margin: 0, color: 'var(--fg-muted)', fontSize: '0.88rem', lineHeight: 1.5 }}>
        {description}
      </p>
      {!isComingSoon && children && <div style={{ marginTop: '0.75rem' }}>{children}</div>}
    </div>
  );
}
