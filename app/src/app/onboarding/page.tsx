'use client';

/**
 * /onboarding — Connector selection screen.
 *
 * Generates a session_id (UUID) on mount, stores it in sessionStorage.
 * For mode=add (returning users), always generates a fresh session_id.
 * User checks active connectors → "Next →" navigates to the first
 * connector screen, passing session_id + mode as URL search params.
 *
 * Coming-soon connectors show a toast on click; iPhone Notes is always
 * disabled. Active connectors: URL, file-upload, bookmarks, upnote, twitter.
 */

import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';

import { SourceCard } from '../../components/SourceCard';
import { useToast } from '../../components/Toast';

const ACTIVE_CONNECTORS = ['url', 'file-upload', 'bookmarks', 'twitter', 'upnote'] as const;
type ActiveConnector = (typeof ACTIVE_CONNECTORS)[number];

interface ConnectorDef {
  id: string;
  icon: string;
  title: string;
  description: string;
  status: 'active' | 'coming-soon' | 'disabled';
}

const CONNECTORS: ConnectorDef[] = [
  { id: 'url', icon: '🔗', title: 'URLs', description: 'Articles, blogs, YouTube links, docs.', status: 'active' },
  { id: 'file-upload', icon: '📄', title: 'Files', description: 'PDF, DOCX, PPTX, images, audio.', status: 'active' },
  { id: 'bookmarks', icon: '🔖', title: 'Browser Bookmarks', description: 'Upload your Chrome / Firefox bookmarks HTML export.', status: 'active' },
  { id: 'upnote', icon: '📔', title: 'Upnote', description: 'Upload your Upnote markdown export.', status: 'active' },
  { id: 'twitter', icon: '𝕏', title: 'Twitter / X Bookmarks', description: 'Upload a JSON export from any Twitter bookmark tool.', status: 'active' },
  { id: 'google-drive', icon: '🗂️', title: 'Google Drive', description: 'Browse and select Drive documents.', status: 'coming-soon' },
  { id: 'notion', icon: '📓', title: 'Notion', description: 'Export from Notion → upload as files.', status: 'coming-soon' },
  { id: 'iphone-notes', icon: '📱', title: 'iPhone Notes', description: 'Coming soon.', status: 'disabled' },
];

function OnboardingPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast, showToast } = useToast();

  const isReturning = searchParams.get('mode') === 'add';

  const [sessionId, setSessionId] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    // Returning users always get a fresh session to avoid mixing with prior runs.
    const id =
      isReturning || !sessionStorage.getItem('kompl_session_id')
        ? crypto.randomUUID()
        : sessionStorage.getItem('kompl_session_id')!;
    sessionStorage.setItem('kompl_session_id', id);
    setSessionId(id);
  }, [isReturning]);

  function toggleConnector(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) {
        next.delete(id);
      } else {
        next.add(id);
      }
      return next;
    });
  }

  const activeSelected = [...selected].filter(id =>
    ACTIVE_CONNECTORS.includes(id as ActiveConnector)
  );

  function handleNext() {
    if (activeSelected.length === 0 || !sessionId) return;
    sessionStorage.setItem('kompl_connectors', JSON.stringify(activeSelected));
    sessionStorage.setItem('kompl_connector_idx', '0');
    const modeParam = isReturning ? '&mode=add' : '';
    router.push(`/onboarding/${activeSelected[0]}?session_id=${sessionId}${modeParam}`);
  }

  return (
    <main style={{ maxWidth: 1040, margin: '0 auto', padding: '3.5rem 1.5rem 5rem' }}>
      <header style={{ marginBottom: '2.5rem' }}>
        <h1 style={{ margin: 0, fontSize: '2.2rem', lineHeight: 1.15 }}>
          {isReturning ? 'What do you want to add?' : 'Where\u2019s your knowledge scattered?'}
        </h1>
        <p style={{ color: 'var(--fg-muted)', fontSize: '1.05rem', marginTop: '0.75rem', maxWidth: 640 }}>
          {isReturning
            ? 'Select where your new sources are.'
            : 'Select all the places you\u2019d like to pull from. You\u2019ll walk through each one.'}
        </p>
      </header>

      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(300px, 1fr))',
          gap: '1.1rem',
        }}
      >
        {CONNECTORS.map(c => {
          if (c.status === 'active') {
            const checked = selected.has(c.id);
            return (
              <div
                key={c.id}
                onClick={() => toggleConnector(c.id)}
                style={{ cursor: 'pointer', position: 'relative' }}
              >
                {/* Checkbox badge */}
                <div
                  style={{
                    position: 'absolute',
                    top: 12,
                    right: 12,
                    zIndex: 1,
                    width: 20,
                    height: 20,
                    borderRadius: 4,
                    border: checked ? '2px solid var(--accent)' : '2px solid var(--border)',
                    background: checked ? 'var(--accent)' : 'transparent',
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    fontSize: 12,
                    color: '#fff',
                    pointerEvents: 'none',
                  }}
                >
                  {checked ? '✓' : ''}
                </div>
                <SourceCard
                  icon={c.icon}
                  title={c.title}
                  description={c.description}
                  status="active"
                />
              </div>
            );
          }

          if (c.status === 'disabled') {
            return (
              <SourceCard
                key={c.id}
                icon={c.icon}
                title={c.title}
                description={c.description}
                status="coming-soon"
              />
            );
          }

          // coming-soon
          return (
            <SourceCard
              key={c.id}
              icon={c.icon}
              title={c.title}
              description={c.description}
              status="coming-soon"
              onClick={() => showToast(`${c.title} — coming soon.`)}
            />
          );
        })}
      </div>

      <div
        style={{
          marginTop: '2.5rem',
          display: 'flex',
          justifyContent: 'flex-end',
          alignItems: 'center',
          gap: '1rem',
        }}
      >
        {activeSelected.length > 0 && (
          <span style={{ color: 'var(--fg-muted)', fontSize: '0.9rem' }}>
            {activeSelected.length} connector{activeSelected.length !== 1 ? 's' : ''} selected
          </span>
        )}
        <button
          onClick={handleNext}
          disabled={activeSelected.length === 0}
          style={{ padding: '0.6rem 1.5rem', fontSize: '1rem' }}
        >
          Next →
        </button>
      </div>

      {toast}
    </main>
  );
}

export default function OnboardingPage() {
  return <Suspense><OnboardingPageInner /></Suspense>;
}
