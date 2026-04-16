import Link from 'next/link';
import WikiPageHeaderActions from './WikiPageHeaderActions';

export interface WikiPageHeaderProps {
  title: string;
  /** Overrides the top label. Defaults to "Kompl Wiki" (links to /wiki). Pass a pre-formatted string to show something else (e.g. a date). */
  label?: string;
  category?: string | null;
  lastUpdated?: string | null;
  /** Replaces the category + divider + lastUpdated meta row with a single string. */
  metaText?: string;
  /** Show the search bar + Graph + Add Sources buttons on the right */
  showActions?: boolean;
}

export function formatHeaderDatetime(iso: string): string {
  const d = new Date(iso.replace(' ', 'T') + (iso.endsWith('Z') ? '' : 'Z'));
  if (isNaN(d.getTime())) return iso;
  const dd   = String(d.getUTCDate()).padStart(2, '0');
  const mm   = String(d.getUTCMonth() + 1).padStart(2, '0');
  const yyyy = d.getUTCFullYear();
  const hh   = String(d.getUTCHours()).padStart(2, '0');
  const min  = String(d.getUTCMinutes()).padStart(2, '0');
  return `${dd}.${mm}.${yyyy} ${hh}.${min}`;
}

export default function WikiPageHeader({
  title,
  label,
  category,
  lastUpdated,
  metaText,
  showActions = false,
}: WikiPageHeaderProps) {
  const labelStyle = {
    fontFamily: 'var(--font-body)',
    fontWeight: 400,
    fontSize: 10,
    lineHeight: '15px',
    letterSpacing: 3,
    textTransform: 'uppercase' as const,
    color: 'var(--accent)',
    textDecoration: 'none',
  };

  return (
    <header
      style={{
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'flex-end',
        paddingBottom: 32,
        gap: 40,
        borderBottom: '1px solid rgba(var(--separator-rgb), 0.1)',
        marginBottom: '1.75rem',
      }}
    >
      {/* Left: label + big title + meta row */}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8, minWidth: 0 }}>

        {/* Top label — custom string or default "Kompl Wiki" link */}
        {label ? (
          <span style={labelStyle}>{label}</span>
        ) : (
          <Link href="/wiki" style={labelStyle}>Kompl Wiki</Link>
        )}

        {/* Big title */}
        <h1
          style={{
            fontFamily: 'var(--font-heading)',
            fontWeight: 700,
            fontSize: 60,
            lineHeight: '60px',
            letterSpacing: -3,
            textTransform: 'uppercase',
            color: 'var(--fg)',
            margin: 0,
          }}
        >
          {title}
        </h1>

        {/* Meta row — either a free-form string or category + divider + last updated */}
        {metaText ? (
          <div style={{ paddingTop: 8 }}>
            <span
              style={{
                fontFamily: 'var(--font-heading)',
                fontWeight: 500,
                fontSize: 12,
                lineHeight: '16px',
                letterSpacing: 1.2,
                textTransform: 'uppercase',
                color: 'var(--accent)',
                opacity: 0.5,
              }}
            >
              {metaText}
            </span>
          </div>
        ) : (category || lastUpdated) ? (
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 16, paddingTop: 8 }}>
            {category && (
              <span
                style={{
                  fontFamily: 'var(--font-heading)',
                  fontWeight: 500,
                  fontSize: 12,
                  lineHeight: '16px',
                  letterSpacing: 1.2,
                  textTransform: 'uppercase',
                  color: 'var(--accent)',
                  opacity: 0.5,
                }}
              >
                {category}
              </span>
            )}
            {category && lastUpdated && (
              <div style={{ width: 40, height: 1, background: 'var(--border-hover)', flexShrink: 0 }} />
            )}
            {lastUpdated && (
              <span
                style={{
                  fontFamily: 'var(--font-mono)',
                  fontWeight: 400,
                  fontSize: 10,
                  lineHeight: '15px',
                  letterSpacing: -0.5,
                  color: 'var(--fg)',
                  opacity: 0.4,
                }}
              >
                last update: {formatHeaderDatetime(lastUpdated)}
              </span>
            )}
          </div>
        ) : null}
      </div>

      {/* Right: search + Graph + Add Sources */}
      {showActions && <WikiPageHeaderActions />}
    </header>
  );
}
