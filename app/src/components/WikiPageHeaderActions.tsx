import Link from 'next/link';
import { Plus } from 'lucide-react';
import WikiViewToggle from './WikiViewToggle';

// Search lives in TopNav only; a second copy here duplicated it on every wiki page.
// Add sources is a 35px square icon button, the view toggle's exact height;
// its name comes from aria-label and the tooltip. Colours, hover and keyboard
// focus live in globals.css (.wiki-add-sources).
export default function WikiPageHeaderActions() {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
      <WikiViewToggle active="wiki" />

      <Link
        href="/onboarding?mode=add"
        className="wiki-add-sources"
        aria-label="Add sources"
        title="Add sources"
        style={{
          display: 'flex', alignItems: 'center', justifyContent: 'center',
          width: 35, height: 35, flexShrink: 0,
          border: '1px solid var(--accent)',
          textDecoration: 'none',
        }}
      >
        <Plus size={16} strokeWidth={2.5} aria-hidden="true" />
      </Link>
    </div>
  );
}
