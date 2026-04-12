'use client';

/**
 * TopNav — global top ribbon present on all app pages.
 *
 * Layout (Obsidian Kinetic, matches Stitch spec):
 *   Left  — KOMPL logo (links to /)
 *   Center — primary nav: Feed · Wiki · Chat · Sources
 *   Right  — search archive input · settings icon
 *
 * Hidden on /onboarding/* (standalone flow, no nav needed).
 * Active link: accent color + 2px bottom border, opacity 1.
 * Inactive links: var(--fg-secondary) at 0.7 opacity.
 */

import Link from 'next/link';
import Image from 'next/image';
import { usePathname, useRouter } from 'next/navigation';
import { Search, Settings } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';

const NAV_ITEMS = [
  { href: '/',        label: 'Home',    isActive: (p: string) => p === '/' },
  { href: '/wiki',    label: 'Wiki',    isActive: (p: string) => p.startsWith('/wiki') || p.startsWith('/page/') },
  { href: '/chat',    label: 'Chat',    isActive: (p: string) => p.startsWith('/chat') },
  { href: '/sources', label: 'Sources', isActive: (p: string) => p.startsWith('/sources') || p.startsWith('/source/') },
] as const;

export default function TopNav() {
  const pathname = usePathname();
  const router = useRouter();
  const [query, setQuery] = useState('');

  if (pathname.startsWith('/onboarding')) return null;

  function handleSearchKey(e: KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Enter' && query.trim()) {
      router.push(`/wiki?q=${encodeURIComponent(query.trim())}`);
    }
  }

  return (
    <header
      style={{
        position: 'fixed',
        top: 0,
        left: 0,
        right: 0,
        height: 65,
        zIndex: 100,
        background: 'var(--bg)',
        borderBottom: '1px solid rgba(71, 72, 74, 0.1)',
        display: 'flex',
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '0 56px',
      }}
    >
      {/* Left — logo */}
      <Link href="/" style={{ display: 'flex', alignItems: 'center', flexShrink: 0 }}>
        <Image
          src="/kompl.png"
          alt="Kompl"
          width={150}
          height={32}
          style={{ objectFit: 'contain', objectPosition: 'left center' }}
          priority
        />
      </Link>

      {/* Center — primary nav */}
      <nav style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 32 }}>
        {NAV_ITEMS.map((item) => {
          const active = item.isActive(pathname);
          return (
            <Link
              key={item.href}
              href={item.href}
              style={{
                fontFamily: 'var(--font-heading)',
                fontSize: 16,
                fontWeight: 400,
                letterSpacing: '-0.4px',
                color: active ? 'var(--accent)' : 'var(--fg-secondary)',
                opacity: active ? 1 : 0.7,
                paddingBottom: active ? 4 : 0,
                borderBottom: active ? '2px solid var(--accent)' : 'none',
                textDecoration: 'none',
                whiteSpace: 'nowrap',
                transition: 'color var(--transition-fast), opacity var(--transition-fast)',
              }}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>

      {/* Right — search + settings */}
      <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 16, flexShrink: 0 }}>
        {/* Search archive */}
        <div style={{ position: 'relative' }}>
          <input
            type="text"
            className="topnav-search"
            placeholder="Search archive"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            onKeyDown={handleSearchKey}
            style={{
              width: 192,
              height: 32,
              background: 'var(--bg-card-hover)',
              border: 'none',
              borderRadius: 4,
              padding: '0 32px 0 12px',
              fontFamily: 'var(--font-body)',
              fontSize: 11,
              letterSpacing: '1.2px',
              textTransform: 'uppercase',
              color: 'var(--fg-secondary)',
            }}
          />
          <Search
            size={13}
            style={{
              position: 'absolute',
              right: 10,
              top: '50%',
              transform: 'translateY(-50%)',
              color: 'var(--accent)',
              opacity: 0.5,
              pointerEvents: 'none',
            }}
          />
        </div>

        {/* Settings */}
        <Link
          href="/settings"
          style={{
            display: 'flex',
            alignItems: 'center',
            color: pathname.startsWith('/settings') ? 'var(--accent)' : 'var(--fg-muted)',
            transition: 'color var(--transition-fast)',
          }}
        >
          <Settings size={16} />
        </Link>
      </div>
    </header>
  );
}
