'use client';

/**
 * Wiki page table of contents with scroll tracking. Highlights the section
 * whose heading most recently passed the upper 40% of the viewport (the last
 * one once the page is scrolled to the bottom), so the reader always sees
 * where they are. Indentation is relative to the shallowest heading level on
 * the page, so pages that only use ### headings aren't all indented.
 */

import { useEffect, useState } from 'react';

export interface TocHeading {
  level: number;
  text: string;
  anchor: string;
}

export default function WikiToc({ headings }: { headings: TocHeading[] }) {
  const [active, setActive] = useState<string>(headings[0]?.anchor ?? '');

  useEffect(() => {
    if (headings.length === 0) return;
    let frame = 0;
    function update() {
      frame = 0;
      const threshold = window.innerHeight * 0.4;
      let current = headings[0].anchor;
      for (const h of headings) {
        const el = document.getElementById(h.anchor);
        if (el && el.getBoundingClientRect().top <= threshold) current = h.anchor;
      }
      if (window.innerHeight + window.scrollY >= document.documentElement.scrollHeight - 4) {
        current = headings[headings.length - 1].anchor;
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
  }, [headings]);

  if (headings.length === 0) return null;
  const baseLevel = Math.min(...headings.map((h) => h.level));

  return (
    <nav aria-label="On this page" style={{ marginBottom: '2rem' }}>
      <div className="meta" style={{ marginBottom: '0.5rem' }}>
        Contents
      </div>
      {headings.map((h, i) => {
        const isActive = h.anchor === active;
        return (
          <a
            key={`${h.anchor}-${i}`}
            href={`#${h.anchor}`}
            aria-current={isActive ? 'location' : undefined}
            onClick={() => setActive(h.anchor)}
            style={{
              display: 'block',
              fontSize: 13,
              lineHeight: 1.4,
              padding: `0.25em 0 0.25em ${0.7 + (h.level - baseLevel) * 0.9}em`,
              borderLeft: `2px solid ${isActive ? 'var(--accent)' : 'var(--border)'}`,
              color: isActive ? 'var(--fg)' : 'var(--fg-muted)',
              fontWeight: isActive ? 500 : 400,
              textDecoration: 'none',
            }}
          >
            {h.text}
          </a>
        );
      })}
    </nav>
  );
}
