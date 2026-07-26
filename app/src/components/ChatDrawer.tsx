'use client';

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useState,
  type ReactNode,
} from 'react';
import { X } from 'lucide-react';
import ChatPanel from './ChatPanel';

interface ChatDrawerContextValue {
  open: boolean;
  setOpen: (open: boolean) => void;
  toggle: () => void;
}

const ChatDrawerContext = createContext<ChatDrawerContextValue | null>(null);

export function useChatDrawer(): ChatDrawerContextValue {
  const ctx = useContext(ChatDrawerContext);
  if (!ctx) {
    return {
      open: false,
      setOpen: () => {},
      toggle: () => {},
    };
  }
  return ctx;
}

const CHAT_SESSION_KEY = 'kompl_chat_session_id';

export function ChatDrawerProvider({ children }: { children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [panelKey, setPanelKey] = useState(0);
  const toggle = useCallback(() => setOpen((v) => !v), []);

  function newConversation() {
    const id = typeof crypto !== 'undefined' ? crypto.randomUUID() : `${Date.now()}`;
    try {
      localStorage.setItem(CHAT_SESSION_KEY, id);
    } catch {}
    setPanelKey((k) => k + 1);
  }

  useEffect(() => {
    if (!open) return;
    function onKey(e: KeyboardEvent) {
      if (e.key === 'Escape') setOpen(false);
    }
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const prev = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = prev;
    };
  }, [open]);

  return (
    <ChatDrawerContext.Provider value={{ open, setOpen, toggle }}>
      {children}
      {open && (
        <>
          <button
            type="button"
            aria-label="Close chat"
            onClick={() => setOpen(false)}
            style={{
              position: 'fixed',
              inset: 0,
              zIndex: 400,
              background: 'rgba(0,0,0,0.45)',
              border: 'none',
              cursor: 'pointer',
              padding: 0,
            }}
          />
          <aside
            role="dialog"
            aria-modal="true"
            aria-label="Chat"
            style={{
              position: 'fixed',
              top: 0,
              right: 0,
              bottom: 0,
              width: 'min(440px, 100vw)',
              zIndex: 401,
              background: 'var(--bg)',
              borderLeft: '1px solid var(--border)',
              display: 'flex',
              flexDirection: 'column',
              boxShadow: '-8px 0 32px rgba(0,0,0,0.35)',
            }}
          >
            <div
              style={{
                height: 56,
                flexShrink: 0,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                padding: '0 12px 0 20px',
                borderBottom: '1px solid rgba(var(--separator-rgb),0.1)',
                gap: 8,
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-heading)',
                  fontWeight: 700,
                  fontSize: 16,
                  letterSpacing: '-0.5px',
                  textTransform: 'uppercase',
                  color: 'var(--fg)',
                }}
              >
                Chat
              </span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                <button
                  type="button"
                  onClick={newConversation}
                  style={{
                    padding: '4px 10px',
                    background: 'none',
                    border: '1px solid var(--border)',
                    cursor: 'pointer',
                    fontFamily: 'var(--font-body)',
                    fontSize: 10,
                    letterSpacing: '1.2px',
                    textTransform: 'uppercase',
                    color: 'var(--fg)',
                  }}
                >
                  + New
                </button>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close"
                  style={{
                    display: 'flex',
                    alignItems: 'center',
                    justifyContent: 'center',
                    width: 32,
                    height: 32,
                    background: 'none',
                    border: '1px solid var(--border)',
                    cursor: 'pointer',
                    color: 'var(--fg-muted)',
                  }}
                >
                  <X size={16} />
                </button>
              </div>
            </div>
            <div style={{ flex: 1, minHeight: 0, position: 'relative' }}>
              <ChatPanel key={panelKey} variant="drawer" hideHeader />
            </div>
          </aside>
        </>
      )}
    </ChatDrawerContext.Provider>
  );
}
