'use client';

import { useState, useRef, useEffect } from 'react';

const DEFERRED = [
  'Google Drive connector',
  'Notion connector',
  'Twitter automated sync',
  'Image support via LLM vision',
  'Custom LLM provider support',
  'Tauri tray app — one-click Start/Stop/Open from the system tray',
];

const NOTES = [
  {
    title: 'OpenAPI codegen + Zod',
    body: 'Currently all 33 API calls between Next.js and the NLP service have hand-written TypeScript interfaces — someone manually typed the request/response shapes in each route file. If the Python side renames content to markdown (which actually happened and silently broke chat), TypeScript doesn\'t catch it. The fix: run openapi-typescript against FastAPI\'s /openapi.json to auto-generate a nlp-client.ts with correct types. Add Zod schemas on the Next.js API route inputs so bad requests from the frontend get rejected at the boundary with a clear 422 instead of crashing inside the handler. A generate-nlp-client.sh script regenerates types when the Python API changes. A Stage 9 test proves the build fails when types drift. None of this is blocking — the product works, the types are just manually maintained. It\'s insurance against the exact kind of silent contract break that already happened once.',
  },
  {
    title: 'Twitter automated sync',
    body: 'Right now the user manually exports bookmarks (runs the bookmarklet, downloads JSON, uploads to Kompl). Twitter automated sync would use bird CLI or the X API v2 to fetch bookmarks automatically on a schedule — no manual export, no JSON upload. The user connects once (OAuth or cookie auth), and new bookmarks sync incrementally. This is v3 because Twitter\'s API is rate-limited, requires a developer account, and the auth surface is fragile.',
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
