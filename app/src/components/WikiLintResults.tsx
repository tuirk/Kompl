'use client';

import Link from 'next/link';
import { useId, useState, type ReactNode } from 'react';
import { LocalDatetime } from './LocalDate';
import {
  type LintResult,
  lintCounts,
  legacyCountHint,
} from '../lib/lint-result';

interface WikiLintResultsProps {
  result: LintResult | null;
  raw?: Record<string, unknown> | null;
  running: boolean;
  /** When the shown result was taken (settings last_lint_at); null when unknown. */
  ranAt?: string | null;
}

interface LintCheckSectionProps {
  label: string;
  count: number;
  legacyHint: boolean;
  variant: 'issue' | 'hint';
  defaultOpen: boolean;
  children: ReactNode;
}

function LintCheckSection({
  label,
  count,
  legacyHint,
  variant,
  defaultOpen,
  children,
}: LintCheckSectionProps) {
  const panelId = useId();
  const [open, setOpen] = useState(defaultOpen);
  const borderColor = variant === 'issue'
    ? 'rgba(var(--warning-rgb), 0.35)'
    : 'rgba(var(--separator-rgb), 0.35)';

  return (
    <div
      style={{
        borderLeft: `4px solid ${borderColor}`,
        marginBottom: '0.65rem',
        paddingLeft: '0.75rem',
      }}
    >
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-controls={panelId}
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          width: '100%',
          background: 'transparent',
          border: 'none',
          cursor: 'pointer',
          padding: '0.35rem 0',
          color: 'inherit',
          font: 'inherit',
          textAlign: 'left',
        }}
      >
        <span
          style={{
            fontFamily: 'var(--font-mono)',
            fontSize: '0.82rem',
            color: variant === 'issue' ? 'var(--warning)' : 'var(--fg-muted)',
          }}
        >
          {label}
        </span>
        <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span
            style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 18,
              fontWeight: 700,
              color: count > 0 ? 'var(--fg)' : 'var(--fg-dim)',
            }}
          >
            {count}
          </span>
          <span style={{ fontSize: 12, color: 'var(--fg-dim)' }}>{open ? '▾' : '▸'}</span>
        </span>
      </button>
      {open && (
        <div id={panelId} style={{ paddingBottom: '0.5rem' }}>
          {legacyHint && count > 0 && (
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 11,
                color: 'var(--fg-dim)',
                marginBottom: 6,
              }}
            >
              Re-run lint to see details
            </div>
          )}
          {count === 0 && !legacyHint && (
            <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-dim)' }}>
              None found
            </div>
          )}
          {children}
        </div>
      )}
    </div>
  );
}

const linkStyle: React.CSSProperties = {
  fontFamily: 'var(--font-mono)',
  fontSize: '0.82rem',
  color: 'var(--accent)',
  textDecoration: 'none',
};

export default function WikiLintResults({ result, raw, running, ranAt = null }: WikiLintResultsProps) {
  if (running) {
    return (
      <div
        style={{
          padding: '0.75rem 0',
          fontFamily: 'var(--font-mono)',
          fontSize: 12,
          color: 'var(--fg-dim)',
        }}
      >
        Running checks…
      </div>
    );
  }

  if (!result) return null;

  const counts = lintCounts(result, raw);

  return (
    <div style={{ paddingTop: '1rem' }}>
      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 10,
          textTransform: 'uppercase',
          letterSpacing: '0.8px',
          color: 'var(--fg-dim)',
          marginBottom: '0.75rem',
        }}
      >
        Last run
        {ranAt && (
          <>
            {' · '}
            <LocalDatetime iso={ranAt} />
          </>
        )}
        {result.run_duration_ms > 0 && (
          <span style={{ marginLeft: 8 }}>{`(${result.run_duration_ms} ms)`}</span>
        )}
      </div>

      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          textTransform: 'uppercase',
          letterSpacing: '0.7px',
          color: 'var(--warning)',
          marginBottom: '0.5rem',
        }}
      >
        Issues
      </div>

      <LintCheckSection
        label="Dead provenance"
        count={counts.deadProv}
        legacyHint={legacyCountHint(counts.deadProv, result.dead_provenance.length)}
        variant="issue"
        defaultOpen={counts.deadProv > 0}
      >
        <ul style={{ margin: 0, paddingLeft: '1.1rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {result.dead_provenance.map((row) => (
            <li key={`${row.provenance_id}-${row.source_id}`}>
              <Link href={`/wiki/${row.page_id}`} style={linkStyle}>
                {row.page_title || row.page_id}
              </Link>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-dim)' }}>
                {' '}
                → deleted source {row.source_id}
              </span>
            </li>
          ))}
        </ul>
      </LintCheckSection>

      {/* This check no longer looks for contradictions: the Disagreements
          check does. A result saved before that change still holds its old
          pairs; they stay stored but are not shown, since they are stale
          and the Disagreements check is where they are kept up to date. */}
      {counts.contradictions > 0 && (
        <div
          style={{ fontFamily: 'var(--font-mono)', fontSize: 11, color: 'var(--fg-dim)', margin: '0 0 0.65rem' }}
        >
          Contradictions are no longer part of this check. See{' '}
          <a href="#wiki-check" style={{ color: 'var(--accent)', textDecoration: 'underline' }}>
            Disagreements between sources
          </a>
          .
        </div>
      )}

      <div
        style={{
          fontFamily: 'var(--font-mono)',
          fontSize: 9,
          textTransform: 'uppercase',
          letterSpacing: '0.7px',
          color: 'var(--fg-dim)',
          margin: '1rem 0 0.5rem',
        }}
      >
        Hints — review when convenient
      </div>

      <LintCheckSection
        label="Orphans"
        count={counts.orphans}
        legacyHint={legacyCountHint(counts.orphans, result.orphan_pages.length)}
        variant="hint"
        defaultOpen={counts.orphans > 0}
      >
        <ul style={{ margin: 0, paddingLeft: '1.1rem', display: 'flex', flexDirection: 'column', gap: 3 }}>
          {result.orphan_pages.map((p) => (
            <li key={p.page_id}>
              <Link href={`/wiki/${p.page_id}`} style={linkStyle}>
                {p.title}
              </Link>
            </li>
          ))}
        </ul>
      </LintCheckSection>

      <LintCheckSection
        label="Stale"
        count={counts.stale}
        legacyHint={legacyCountHint(counts.stale, result.stale_pages.length)}
        variant="hint"
        defaultOpen={counts.stale > 0}
      >
        <ul style={{ margin: 0, paddingLeft: '1.1rem', display: 'flex', flexDirection: 'column', gap: 4 }}>
          {result.stale_pages.map((p) => (
            <li key={p.page_id}>
              <Link href={`/wiki/${p.page_id}`} style={linkStyle}>
                {p.title}
              </Link>
              {p.last_updated && (
                <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)', marginLeft: 8 }}>
                  — last update: <LocalDatetime iso={p.last_updated} />
                </span>
              )}
            </li>
          ))}
        </ul>
      </LintCheckSection>

      <LintCheckSection
        label="Missing cross-refs"
        count={counts.crossRefs}
        legacyHint={false}
        variant="hint"
        defaultOpen={counts.crossRefs > 0}
      >
        <ul style={{ margin: 0, paddingLeft: 0, listStyle: 'none', display: 'flex', flexDirection: 'column', gap: 3 }}>
          {result.missing_cross_refs.map((ref) => (
            <li key={ref.entity_text} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
              <Link
                href={`/wiki/search?q=${encodeURIComponent(ref.entity_text)}`}
                style={linkStyle}
              >
                {ref.entity_text}
              </Link>
              <span style={{ fontFamily: 'var(--font-mono)', fontSize: 10, color: 'var(--fg-dim)' }}>
                {ref.mention_count} source{ref.mention_count !== 1 ? 's' : ''}
              </span>
            </li>
          ))}
        </ul>
      </LintCheckSection>
    </div>
  );
}
