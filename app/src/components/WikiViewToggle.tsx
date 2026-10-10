import Link from 'next/link';
import { BookOpen, Network } from 'lucide-react';

/**
 * Wiki ⇄ Graph view switch. Same control on /wiki (+ article pages) and
 * /wiki/graph so the graph reads as a second view of the wiki, not a
 * separate destination. No hooks — usable from server and client pages.
 * Colours, hover and keyboard focus live in globals.css (.wiki-view-toggle).
 */

export type WikiView = 'wiki' | 'graph';

const VIEWS = [
  { view: 'wiki',  href: '/wiki',       label: 'Wiki',  Icon: BookOpen },
  { view: 'graph', href: '/wiki/graph', label: 'Graph', Icon: Network },
] as const;

export default function WikiViewToggle({ active }: { active: WikiView }) {
  return (
    <nav
      aria-label="Wiki view"
      className="wiki-view-toggle"
      style={{
        // A fixed height, borders included, so it lines up exactly with the
        // 35px Add sources button (a content-sized box gains a fraction of a
        // pixel under html zoom); the links stretch to fill it.
        display: 'flex', height: 35,
        border: '1px solid rgba(var(--accent-rgb),0.2)',
        background: 'var(--bg-card-hover)',
        flexShrink: 0,
      }}
    >
      {VIEWS.map(({ view, href, label, Icon }) => {
        const on = view === active;
        return (
          <Link
            key={view}
            href={href}
            aria-current={on ? 'page' : undefined}
            style={{
              display: 'flex', alignItems: 'center', gap: 8,
              padding: '0 14px',
              fontFamily: 'var(--font-heading)',
              fontWeight: 700, fontSize: 10, lineHeight: '15px',
              letterSpacing: 1, textTransform: 'uppercase',
              textDecoration: 'none',
            }}
          >
            <Icon size={12} style={{ opacity: on ? 1 : 0.7 }} />
            {label}
          </Link>
        );
      })}
    </nav>
  );
}
