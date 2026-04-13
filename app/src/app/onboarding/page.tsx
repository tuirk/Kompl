'use client';

/**
 * /onboarding — Connector selection screen.
 *
 * Generates a session_id (UUID) on mount, stores it in sessionStorage.
 * User checks active connectors → "Next →" navigates to the first
 * connector screen, passing session_id as a URL search param.
 */

import Link from 'next/link';
import { useRouter, useSearchParams } from 'next/navigation';
import { Suspense, useEffect, useState } from 'react';
import {
  Globe, FileUp, Bookmark, BookOpen, AtSign,
  Smartphone, HardDrive, Book, ArrowRight,
} from 'lucide-react';
import { useToast } from '../../components/Toast';

type ConnectorStatus = 'active' | 'coming-soon';

interface ConnectorDef {
  id: string;
  Icon: React.ElementType;
  title: string;
  subtitle: string;
  status: ConnectorStatus;
}

const CONNECTORS: ConnectorDef[] = [
  { id: 'url',          Icon: Globe,      title: 'URL',               subtitle: 'Live Web Indexing',    status: 'active' },
  { id: 'file-upload',  Icon: FileUp,     title: 'File Upload',       subtitle: 'PDF, Markdown, JSON',  status: 'active' },
  { id: 'bookmarks',    Icon: Bookmark,   title: 'Browser Bookmarks', subtitle: 'Browser Sync',         status: 'active' },
  { id: 'twitter',      Icon: AtSign,     title: 'Twitter / X',       subtitle: 'Social Intelligence',  status: 'active' },
  { id: 'apple-notes',  Icon: Smartphone, title: 'Apple Notes',       subtitle: 'Native Notes',         status: 'active' },
  { id: 'upnote',       Icon: BookOpen,   title: 'Upnote',            subtitle: 'Knowledge Management', status: 'active' },
  { id: 'google-drive', Icon: HardDrive,  title: 'Google Drive',      subtitle: 'Cloud Storage',        status: 'coming-soon' },
  { id: 'notion',       Icon: Book,       title: 'Notion',            subtitle: 'Workspace',            status: 'coming-soon' },
];

const ACTIVE_IDS = new Set(CONNECTORS.filter(c => c.status === 'active').map(c => c.id));

function OnboardingPageInner() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const { toast, showToast } = useToast();

  const [sessionId, setSessionId] = useState<string>('');
  const [selected, setSelected] = useState<Set<string>>(new Set());

  useEffect(() => {
    const id = sessionStorage.getItem('kompl_session_id') ?? crypto.randomUUID();
    sessionStorage.setItem('kompl_session_id', id);
    setSessionId(id);
  }, []);

  function toggleConnector(id: string) {
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }

  const activeSelected = CONNECTORS
    .map(c => c.id)
    .filter(id => selected.has(id) && ACTIVE_IDS.has(id));

  function handleNext() {
    if (activeSelected.length === 0 || !sessionId) return;
    sessionStorage.setItem('kompl_connectors', JSON.stringify(activeSelected));
    sessionStorage.setItem('kompl_connector_idx', '0');
    router.push(`/onboarding/${activeSelected[0]}?session_id=${sessionId}`);
  }

  const heading = 'Select Your Data Sources.';
  const subtitle = "Pick all the places your knowledge lives. You'll walk through each connector.";

  return (
    <>
      <main style={{ maxWidth: 1040, margin: '0 auto', padding: '1.5rem 40px 100px' }}>

        {/* Header */}
        <section style={{ display: 'flex', flexDirection: 'column', gap: 12, marginBottom: 32 }}>
          <Link
            href="/"
            style={{
              fontFamily: 'var(--font-body)',
              fontWeight: 400,
              fontSize: 10,
              lineHeight: '15px',
              letterSpacing: 3,
              textTransform: 'uppercase',
              color: 'var(--accent)',
              textDecoration: 'none',
            }}
          >
            ← Dashboard
          </Link>
          <h1 style={{
            fontFamily: 'var(--font-heading)',
            fontWeight: 700,
            fontSize: 52,
            lineHeight: '54px',
            letterSpacing: '-2.6px',
            color: 'var(--fg)',
            margin: 0,
          }}>
            {heading}
          </h1>
          <p style={{
            fontFamily: 'var(--font-body)',
            fontWeight: 400,
            fontSize: 13,
            lineHeight: '20px',
            letterSpacing: '0.2px',
            color: 'var(--fg-dim)',
            margin: 0,
            maxWidth: 460,
          }}>
            {subtitle}
          </p>
        </section>

        <div style={{ textAlign: 'center', marginBottom: '0.75rem' }}>
          <span style={{ fontSize: '0.8rem', color: 'var(--fg-muted)' }}>
            Have a Kompl export?{' '}
            <Link href="/settings#import" style={{ color: 'var(--accent)', textDecoration: 'none' }}>
              Import it here →
            </Link>
          </span>
        </div>

        {/* Connector grid — 4 cols × 2 rows */}
        <div style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(4, 1fr)',
          columnGap: 12,
          rowGap: 16,
        }}>
          {CONNECTORS.map(c => {
            const checked = selected.has(c.id);

            if (c.status === 'active') {
              return (
                <div
                  key={c.id}
                  onClick={() => toggleConnector(c.id)}
                  style={{
                    background: 'var(--bg-card)',
                    padding: 24,
                    display: 'flex',
                    flexDirection: 'column',
                    gap: 32,
                    cursor: 'pointer',
                    boxSizing: 'border-box',
                    outline: checked ? '1px solid rgba(137,240,203,0.25)' : '1px solid transparent',
                    transition: 'outline 0.1s',
                  }}
                >
                  {/* Top row: connector icon + selection indicator */}
                  <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                    <c.Icon size={16} style={{ color: 'var(--accent)', flexShrink: 0 }} />
                    {/* Square radio indicator */}
                    <div style={{
                      width: 16,
                      height: 16,
                      border: '1px solid var(--accent)',
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                      flexShrink: 0,
                    }}>
                      <div style={{
                        width: 9,
                        height: 9,
                        background: 'var(--accent)',
                        opacity: checked ? 1 : 0,
                        transition: 'opacity 0.1s',
                      }} />
                    </div>
                  </div>

                  {/* Title + subtitle */}
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                    <span style={{
                      fontFamily: 'var(--font-heading)',
                      fontWeight: 700,
                      fontSize: 16,
                      lineHeight: '22px',
                      color: 'var(--fg)',
                    }}>
                      {c.title}
                    </span>
                    <span style={{
                      fontFamily: 'var(--font-mono)',
                      fontSize: 9,
                      lineHeight: '14px',
                      letterSpacing: '0.8px',
                      textTransform: 'uppercase',
                      color: 'var(--fg-dim)',
                    }}>
                      {c.subtitle}
                    </span>
                  </div>
                </div>
              );
            }

            // coming-soon
            return (
              <div
                key={c.id}
                onClick={() => showToast(`${c.title} — coming soon.`)}
                style={{
                  background: 'var(--bg)',
                  padding: 24,
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 32,
                  opacity: 0.6,
                  cursor: 'pointer',
                  boxSizing: 'border-box',
                }}
              >
                {/* Top row: icon + SOON badge */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'flex-start' }}>
                  <c.Icon size={16} style={{ color: 'var(--fg-dim)', flexShrink: 0 }} />
                  <span style={{
                    border: '1px solid rgba(171,171,173,0.3)',
                    padding: '4px 8px',
                    fontFamily: 'var(--font-mono)',
                    fontSize: 8,
                    lineHeight: '12px',
                    letterSpacing: '0.8px',
                    textTransform: 'uppercase',
                    color: 'var(--fg)',
                    whiteSpace: 'nowrap',
                    flexShrink: 0,
                  }}>
                    Soon
                  </span>
                </div>

                {/* Title + subtitle */}
                <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                  <span style={{
                    fontFamily: 'var(--font-heading)',
                    fontWeight: 700,
                    fontSize: 16,
                    lineHeight: '22px',
                    color: 'var(--fg-dim)',
                  }}>
                    {c.title}
                  </span>
                  <span style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    lineHeight: '14px',
                    letterSpacing: '0.8px',
                    textTransform: 'uppercase',
                    color: 'rgba(171,171,173,0.5)',
                  }}>
                    {c.subtitle}
                  </span>
                </div>
              </div>
            );
          })}
        </div>

        {/* Inline footer nav */}
        <div style={{
          position: 'fixed',
          bottom: 32, left: 0, right: 0,
          zIndex: 50,
          background: 'var(--bg)',
          borderTop: '1px solid rgba(71,72,74,0.12)',
          padding: '16px 56px',
          display: 'flex',
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}>
          {/* Left: selection count */}
          <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 16 }}>
            <span style={{
              fontFamily: 'var(--font-mono)',
              fontSize: 10,
              lineHeight: '15px',
              letterSpacing: '1px',
              textTransform: 'uppercase',
              color: 'var(--fg-dim)',
            }}>
              {activeSelected.length > 0
                ? `${activeSelected.length} Source${activeSelected.length !== 1 ? 's' : ''} Selected`
                : 'None Selected'}
            </span>
          </div>

          {/* Right: primary button */}
          <button
            onClick={handleNext}
            disabled={activeSelected.length === 0}
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
              padding: '16px 32px',
              background: activeSelected.length === 0 ? 'rgba(137,240,203,0.2)' : 'var(--accent)',
              border: 'none',
              cursor: activeSelected.length === 0 ? 'not-allowed' : 'pointer',
              fontFamily: 'var(--font-mono)',
              fontWeight: 700,
              fontSize: 10,
              lineHeight: '15px',
              letterSpacing: '1px',
              textTransform: 'uppercase',
              color: 'var(--accent-text)',
            }}
          >
            Next
            <ArrowRight size={9} style={{ color: 'var(--accent-text)', flexShrink: 0 }} />
          </button>
        </div>
      </main>

      {toast}
    </>
  );
}

export default function OnboardingPage() {
  return <Suspense><OnboardingPageInner /></Suspense>;
}
