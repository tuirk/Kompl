'use client';

import { useState, useRef, useEffect } from 'react';

const DEFERRED = [
  'Google Drive and Notion connectors',
  'Image support via LLM vision',
  'Custom LLM provider support',
  'Tauri tray app — one-click Start/Stop/Open from the system tray',
  'Basic schema editing (moving sources under other topics, renaming topics, etc.)',
  'Improved Wiki Health Checks',
  'Weekly backup remote channels — Telegram attach + Google Drive OAuth2',
  'Rank new entity and concept pages by signal strength and defer the weak ones, so the AI only drafts pages worth writing',
];

const NOTES = [
  {
    title: 'Merge import',
    body: 'Import currently only works on an empty wiki — it returns 409 if any pages already exist. Merge import would dedup sources by URL and content hash, skip pages that already exist, import only net-new data, and merge provenance records across the two instances. The tricky edge cases are conflicting page content (two instances compiled the same source differently) and divergent entity resolution (entity "React" resolved to the JS framework in one export but to a chemistry concept in another). Deferred for now. The workaround is to re-ingest sources through onboarding — you get the same end result because compilation is deterministic per source.',
  },
];

export default function WhatsNext() {
  const [open, setOpen] = useState(false);
  const [expandedNote, setExpandedNote] = useState<number | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    function handleClick(e: MouseEvent) {
      if (ref.current && !ref.current.contains(e.target as Node)) {
        setOpen(false);
        setExpandedNote(null);
      }
    }
    document.addEventListener('mousedown', handleClick);
    return () => document.removeEventListener('mousedown', handleClick);
  }, [open]);

  return (
    <div ref={ref} style={{ position: 'relative' }}>
      <button
        onClick={() => { setOpen(o => !o); setExpandedNote(null); }}
        style={{
          background: 'none',
          border: 'none',
          cursor: 'pointer',
          display: 'flex',
          alignItems: 'center',
          gap: 5,
          padding: '0 8px',
          height: 32,
          color: open ? 'var(--accent)' : 'var(--fg-secondary)',
          fontFamily: 'var(--font-heading)',
          fontSize: 12,
          letterSpacing: '0.04em',
          transition: 'color 0.15s',
        }}
      >
        <span style={{ fontSize: 10, transform: open ? 'rotate(180deg)' : 'none', display: 'inline-block', transition: 'transform 0.15s' }}>▲</span>
        What's next
      </button>

      {open && (
        <div style={{
          position: 'absolute',
          bottom: 36,
          left: 0,
          width: 420,
          background: 'var(--bg-card)',
          border: '1px solid var(--border)',
          borderRadius: 8,
          padding: '16px 20px',
          boxShadow: '0 -8px 32px rgba(0,0,0,0.4)',
          zIndex: 200,
          maxHeight: 'calc(100dvh / 0.9 - 120px)',
          overflowY: 'auto',
        }}>

          <p style={{ fontFamily: 'var(--font-heading)', fontSize: 11, color: 'var(--fg-dim)', letterSpacing: '0.08em', textTransform: 'uppercase', margin: '0 0 10px' }}>
            Deferred to v2
          </p>
          <ul style={{ margin: '0 0 20px', padding: '0 0 0 18px', listStyle: 'disc' }}>
            {DEFERRED.map(item => (
              <li key={item} style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--fg-secondary)', lineHeight: 1.7 }}>
                {item}
              </li>
            ))}
          </ul>

          <p style={{ fontFamily: 'var(--font-heading)', fontSize: 11, color: 'var(--fg-dim)', letterSpacing: '0.08em', textTransform: 'uppercase', margin: '0 0 10px' }}>
            Notes
          </p>
          <ul style={{ margin: 0, padding: 0, listStyle: 'none' }}>
            {NOTES.map((note, i) => (
              <li key={note.title} style={{ marginBottom: 6 }}>
                <button
                  onClick={() => setExpandedNote(expandedNote === i ? null : i)}
                  style={{
                    background: 'none',
                    border: 'none',
                    cursor: 'pointer',
                    padding: 0,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 6,
                    width: '100%',
                    textAlign: 'left',
                  }}
                >
                  <span style={{ fontSize: 9, color: 'var(--fg-dim)', flexShrink: 0, transform: expandedNote === i ? 'rotate(90deg)' : 'none', display: 'inline-block', transition: 'transform 0.15s' }}>▶</span>
                  <span style={{ fontFamily: 'var(--font-body)', fontSize: 13, color: 'var(--fg-secondary)' }}>{note.title}</span>
                </button>
                {expandedNote === i && (
                  <p style={{
                    fontFamily: 'var(--font-body)',
                    fontSize: 12,
                    color: 'var(--fg-muted)',
                    lineHeight: 1.65,
                    margin: '8px 0 4px 15px',
                  }}>
                    {note.body}
                  </p>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
