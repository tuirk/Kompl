'use client';

import { useEffect, useRef, useState } from 'react';
import Link from 'next/link';
import type { ChatMessage, Citation } from '@/lib/chat-types';

interface WikiStatsSnapshot {
  source_count: number;
  page_count: number;
  entity_count: number;
  concept_count: number;
  last_ingested: string | null;
  last_compiled: string | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTime(iso: string): string {
  const d = new Date(iso);
  const hh = d.getHours().toString().padStart(2, '0');
  const mm = d.getMinutes().toString().padStart(2, '0');
  const ss = d.getSeconds().toString().padStart(2, '0');
  return `[${hh}:${mm}:${ss}]`;
}

// ---------------------------------------------------------------------------
// Citation chip rendering
// ---------------------------------------------------------------------------

const CHIP_STYLE: React.CSSProperties = {
  display: 'inline-flex',
  alignItems: 'center',
  padding: '1px 6px 2px',
  background: 'rgba(var(--accent-rgb),0.1)',
  border: '1px solid rgba(var(--accent-rgb),0.3)',
  color: 'var(--accent)',
  fontFamily: 'var(--font-heading)',
  fontWeight: 700,
  fontSize: 10,
  textDecoration: 'none',
  letterSpacing: 0,
  verticalAlign: 'middle',
  marginLeft: 2,
};

function Chip({ citation, label, k }: { citation: Citation; label: string; k: string | number }) {
  return (
    <Link key={k} href={`/wiki/${citation.page_id}`} style={CHIP_STYLE}>
      {label}
    </Link>
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/**
 * Pass 2: scan an unbracketed text span for literal page_title occurrences and
 * wrap each match as a chip. Longest titles match first so a page called
 * "Cookie Usage Policy" wins over "Cookie Usage" when both are in the citations
 * list. Case-insensitive, word-boundary-anchored, minimum length 3.
 */
function linkifyLiteralTitles(
  text: string,
  sortedCitations: Citation[],
  keyPrefix: string,
): React.ReactNode[] {
  if (!text || sortedCitations.length === 0) return [<span key={keyPrefix}>{text}</span>];
  const pattern = new RegExp(
    `\\b(${sortedCitations.map((c) => escapeRegex(c.page_title)).join('|')})\\b`,
    'gi',
  );
  const out: React.ReactNode[] = [];
  let lastIdx = 0;
  let n = 0;
  let m: RegExpExecArray | null;
  while ((m = pattern.exec(text)) !== null) {
    if (m.index > lastIdx) {
      out.push(<span key={`${keyPrefix}-${n++}`}>{text.slice(lastIdx, m.index)}</span>);
    }
    const matchedText = m[1];
    const cit = sortedCitations.find(
      (c) => c.page_title.toLowerCase() === matchedText.toLowerCase(),
    );
    if (cit) {
      out.push(<Chip key={`${keyPrefix}-${n++}`} citation={cit} label={matchedText} k={`${keyPrefix}-${n}`} />);
    } else {
      out.push(<span key={`${keyPrefix}-${n++}`}>{matchedText}</span>);
    }
    lastIdx = m.index + matchedText.length;
  }
  if (lastIdx < text.length) {
    out.push(<span key={`${keyPrefix}-${n++}`}>{text.slice(lastIdx)}</span>);
  }
  return out;
}

function renderAnswer(answer: string, citations: Citation[]) {
  const citationMap = new Map(
    citations.map((c) => [c.page_title.toLowerCase(), c]),
  );
  const fallback = [...citations]
    .filter((c) => c.page_title.length >= 3)
    .sort((a, b) => b.page_title.length - a.page_title.length);

  const parts = answer.split(/(\[[^\]]+\])/g);
  const nodes: React.ReactNode[] = [];
  parts.forEach((part, i) => {
    const match = part.match(/^\[([^\]]+)\]$/);
    if (match) {
      const title = match[1];
      const citation = citationMap.get(title.toLowerCase());
      if (citation) {
        nodes.push(<Chip key={`b-${i}`} citation={citation} label={title} k={`b-${i}`} />);
        return;
      }
    }
    nodes.push(...linkifyLiteralTitles(part, fallback, `s-${i}`));
  });
  return nodes;
}

// ---------------------------------------------------------------------------
// Typing indicator
// ---------------------------------------------------------------------------

function TypingIndicator() {
  return (
    <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 16, padding: '0 0 4px' }}>
      <span
        style={{
          fontFamily: 'var(--font-body)',
          fontWeight: 700,
          fontSize: 10,
          lineHeight: '15px',
          letterSpacing: 1,
          textTransform: 'uppercase',
          color: 'var(--accent)',
        }}
      >
        KOMPL_PROCESSING
      </span>
      <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
        {[0.4, 0.6, 1].map((opacity, i) => (
          <span
            key={i}
            style={{
              width: 6,
              height: 6,
              background: `rgba(var(--accent-rgb),${opacity})`,
              display: 'inline-block',
              animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
            }}
          />
        ))}
      </div>
      <style>{`
        @keyframes pulse {
          0%, 80%, 100% { opacity: 0.3; }
          40% { opacity: 1; }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Example questions
// ---------------------------------------------------------------------------

// Tailored to what the agent can actually do: the stat bar covers "how many"
// questions, so the example prompts push toward retrieval + synthesis and one
// fast-path (topics) that returns a category breakdown.
const EXAMPLE_QUESTIONS = [
  'What topics does my wiki cover?',
  'Summarise my most recent sources',
  'Find connections across my sources',
  'What are the key themes?',
];

function formatRelativeTime(iso: string | null): string {
  if (!iso) return 'never';
  const then = new Date(iso).getTime();
  if (Number.isNaN(then)) return 'never';
  const diff = Date.now() - then;
  const s = Math.floor(diff / 1000);
  if (s < 60) return 'just now';
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ago`;
  const h = Math.floor(m / 60);
  if (h < 24) return `${h}h ago`;
  const d = Math.floor(h / 24);
  return `${d}d ago`;
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export default function ChatPage() {
  const [sessionId, setSessionId] = useState<string>(() =>
    typeof crypto !== 'undefined' ? crypto.randomUUID() : `${Date.now()}`,
  );
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [isLoading, setIsLoading] = useState(false);
  const [savedDrafts, setSavedDrafts] = useState<Set<number>>(new Set());
  const [stats, setStats] = useState<WikiStatsSnapshot | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const bottomRef = useRef<HTMLDivElement>(null);

  // Reset session
  function newConversation() {
    setSessionId(
      typeof crypto !== 'undefined' ? crypto.randomUUID() : `${Date.now()}`,
    );
    setMessages([]);
    setInput('');
  }

  // Fetch wiki stats once on mount for the header chip
  useEffect(() => {
    let cancelled = false;
    fetch('/api/wiki/stats')
      .then((r) => (r.ok ? (r.json() as Promise<WikiStatsSnapshot>) : null))
      .then((data) => {
        if (!cancelled) setStats(data);
      })
      .catch(() => {
        if (!cancelled) setStats(null);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Auto-scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const maxHeight = 24 * 4;
    el.style.height = `${Math.min(el.scrollHeight, maxHeight)}px`;
  }, [input]);

  async function sendMessage(question: string) {
    if (!question.trim() || isLoading) return;
    const userMsg: ChatMessage = {
      id: Date.now(),
      role: 'user',
      content: question,
      citations: [],
      created_at: new Date().toISOString(),
    };
    setMessages((prev) => [...prev, userMsg]);
    setInput('');
    setIsLoading(true);
    try {
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: sessionId, question }),
      });
      const data = (await res.json()) as {
        answer?: string;
        citations?: Citation[];
        error?: string;
      };
      const assistantMsg: ChatMessage = {
        id: Date.now() + 1,
        role: 'assistant',
        content: data.error
          ? `Error: ${data.error}`
          : (data.answer ?? 'No answer returned.'),
        citations: data.citations ?? [],
        created_at: new Date().toISOString(),
      };
      setMessages((prev) => [...prev, assistantMsg]);
    } catch (err) {
      setMessages((prev) => [
        ...prev,
        {
          id: Date.now() + 1,
          role: 'assistant',
          content: `Network error: ${err instanceof Error ? err.message : 'unknown'}`,
          citations: [],
          created_at: new Date().toISOString(),
        },
      ]);
    } finally {
      setIsLoading(false);
    }
  }

  async function saveAsDraft(msg: ChatMessage) {
    await fetch('/api/chat/save-draft', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        session_id: sessionId,
        content: msg.content,
        citations: msg.citations,
      }),
    });
    setSavedDrafts((prev) => new Set(prev).add(msg.id));
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault();
      void sendMessage(input);
    }
  }

  const isEmpty = messages.length === 0;

  return (
    <div
      style={{
        position: 'relative',
        height: 'calc(100dvh / 0.9 - 97px)',
        overflow: 'hidden',
        maxWidth: 1040,
        margin: '0 auto',
      }}
    >
      {/* ------------------------------------------------------------------ */}
      {/* Header                                                               */}
      {/* ------------------------------------------------------------------ */}
      <header
        style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: 64,
          display: 'flex',
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '0 56px',
          background: 'rgba(13,14,16,0.8)',
          borderBottom: '1px solid rgba(var(--separator-rgb),0.05)',
          backdropFilter: 'blur(6px)',
          zIndex: 10,
        }}
      >
        {/* Left: title + model badge */}
        <div style={{ display: 'flex', flexDirection: 'row', alignItems: 'center', gap: 12 }}>
          <span
            style={{
              fontFamily: 'var(--font-heading)',
              fontWeight: 700,
              fontSize: 20,
              lineHeight: '28px',
              letterSpacing: '-0.5px',
              textTransform: 'uppercase',
              color: 'var(--fg)',
            }}
          >
            Kompl Chat
          </span>

          {/* Provider badge */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'center',
              gap: 8,
              padding: '2px 8px',
              background: 'var(--bg-card-hover)',
              border: '1px solid rgba(var(--accent-rgb),0.2)',
            }}
          >
            <div
              style={{
                width: 6,
                height: 6,
                borderRadius: '50%',
                background: 'var(--accent)',
                flexShrink: 0,
              }}
            />
            <span
              style={{
                fontFamily: 'var(--font-body)',
                fontWeight: 400,
                fontSize: 10,
                lineHeight: '15px',
                color: 'var(--accent)',
                whiteSpace: 'nowrap',
              }}
            >
              GEMINI 2.5 FLASH
            </span>
          </div>

          {/* Stat chip — persistent snapshot so users don't have to ask */}
          {stats && (
            <div
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 8,
                padding: '2px 8px',
                background: 'var(--bg-card-hover)',
                border: '1px solid rgba(var(--separator-rgb),0.2)',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-body)',
                  fontWeight: 400,
                  fontSize: 10,
                  lineHeight: '15px',
                  letterSpacing: '0.5px',
                  textTransform: 'uppercase',
                  color: 'var(--fg-muted)',
                  whiteSpace: 'nowrap',
                }}
              >
                {`${stats.source_count} SOURCES · ${stats.page_count} PAGES · UPDATED ${formatRelativeTime(stats.last_compiled)}`}
              </span>
            </div>
          )}
        </div>

        {/* Right: new conversation */}
        <button
          onClick={newConversation}
          style={{
            display: 'flex',
            flexDirection: 'row',
            alignItems: 'center',
            gap: 8,
            padding: '6px 16px',
            background: 'none',
            border: '1px solid var(--border)',
            cursor: 'pointer',
            fontFamily: 'var(--font-body)',
            fontWeight: 400,
            fontSize: 12,
            lineHeight: '16px',
            letterSpacing: '1.2px',
            textTransform: 'uppercase',
            color: 'var(--fg)',
          }}
        >
          + New Conversation
        </button>
      </header>

      {/* ------------------------------------------------------------------ */}
      {/* Message area                                                         */}
      {/* ------------------------------------------------------------------ */}
      <div
        style={{
          position: 'absolute',
          top: 64,
          bottom: 172,
          left: 0,
          right: 0,
          overflowY: 'auto',
          padding: '32px 56px',
          display: 'flex',
          flexDirection: 'column',
          gap: 32,
        }}
      >
        {isEmpty && (
          <div
            style={{
              flex: 1,
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            <p
              style={{
                fontFamily: 'var(--font-body)',
                fontSize: 12,
                letterSpacing: '1px',
                textTransform: 'uppercase',
                color: 'var(--fg-muted)',
                margin: 0,
              }}
            >
              Ask anything about your compiled wiki.
            </p>
            <p
              style={{
                fontFamily: 'var(--font-body)',
                fontSize: 10,
                letterSpacing: '0.5px',
                color: 'var(--fg-dim)',
                margin: 0,
                textAlign: 'center',
                maxWidth: 520,
              }}
            >
              This chat is intentionally primitive — basic info + testing only.
              Fork and tailor it for your own workflow.
            </p>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: msg.role === 'user' ? 'flex-end' : 'flex-start',
              gap: 8,
            }}
          >
            {/* Label row */}
            <div
              style={{
                display: 'flex',
                flexDirection: 'row',
                alignItems: 'center',
                gap: 12,
                justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
              }}
            >
              <span
                style={{
                  fontFamily: 'var(--font-body)',
                  fontWeight: msg.role === 'assistant' ? 700 : 400,
                  fontSize: 10,
                  lineHeight: '15px',
                  letterSpacing: '1px',
                  textTransform: 'uppercase',
                  color: msg.role === 'assistant' ? 'var(--accent)' : 'var(--fg-muted)',
                }}
              >
                {msg.role === 'assistant' ? 'KOMPL_INTELLIGENCE' : 'OPERATOR'}
              </span>
              <span
                style={{
                  fontFamily: 'var(--font-body)',
                  fontWeight: msg.role === 'assistant' ? 700 : 400,
                  fontSize: 10,
                  lineHeight: '15px',
                  letterSpacing: '1px',
                  textTransform: 'uppercase',
                  color: msg.role === 'assistant' ? 'var(--accent)' : 'var(--fg-muted)',
                }}
              >
                {formatTime(msg.created_at)}
              </span>
            </div>

            {/* Bubble card */}
            <div
              style={{
                maxWidth: 672,
                padding: msg.role === 'user' ? '20px' : '24px',
                background: msg.role === 'user' ? 'var(--bg-card-hover)' : 'var(--bg-card)',
                borderLeft: msg.role === 'user'
                  ? '2px solid rgba(var(--accent-rgb),0.5)'
                  : '2px solid var(--accent)',
                fontFamily: 'var(--font-heading)',
                fontWeight: 400,
                fontSize: 16,
                lineHeight: '26px',
                color: 'var(--fg)',
                wordBreak: 'break-word',
                whiteSpace: 'pre-wrap',
              }}
            >
              {msg.role === 'assistant' && msg.citations.length > 0
                ? renderAnswer(msg.content, msg.citations)
                : msg.content}
            </div>

            {/* Save to wiki (assistant only) */}
            {msg.role === 'assistant' && (
              <button
                onClick={() => void saveAsDraft(msg)}
                disabled={savedDrafts.has(msg.id)}
                style={{
                  background: 'none',
                  border: 'none',
                  cursor: savedDrafts.has(msg.id) ? 'default' : 'pointer',
                  fontFamily: 'var(--font-body)',
                  fontSize: 10,
                  letterSpacing: '1px',
                  textTransform: 'uppercase',
                  color: savedDrafts.has(msg.id) ? 'var(--success)' : 'var(--fg-dim)',
                  padding: '2px 0',
                }}
              >
                {savedDrafts.has(msg.id) ? '✓ Saved to wiki' : 'Save to wiki'}
              </button>
            )}
          </div>
        ))}

        {isLoading && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <TypingIndicator />
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* ------------------------------------------------------------------ */}
      {/* Footer — sticky input + example questions                            */}
      {/* ------------------------------------------------------------------ */}
      <footer
        style={{
          position: 'absolute',
          bottom: 0,
          left: 0,
          right: 0,
          height: 172,
          background: 'var(--bg)',
          borderTop: '1px solid rgba(var(--separator-rgb),0.1)',
          padding: '24px 56px',
          display: 'flex',
          flexDirection: 'column',
          gap: 16,
        }}
      >
        {/* Example question buttons */}
        <div style={{ display: 'flex', flexDirection: 'row', gap: 12, flexWrap: 'nowrap', justifyContent: 'center' }}>
          {EXAMPLE_QUESTIONS.map((q) => (
            <button
              key={q}
              onClick={() => void sendMessage(q)}
              disabled={isLoading}
              style={{
                textAlign: 'center',
                padding: '8px',
                background: 'none',
                border: '1px solid rgba(var(--separator-rgb),0.2)',
                cursor: isLoading ? 'default' : 'pointer',
                fontFamily: 'var(--font-body)',
                fontWeight: 400,
                fontSize: 10,
                lineHeight: '15px',
                textTransform: 'uppercase',
                color: 'var(--fg-muted)',
                whiteSpace: 'nowrap',
                overflow: 'hidden',
                textOverflow: 'ellipsis',
              }}
            >
              {q}
            </button>
          ))}
        </div>

        {/* Input field wrapper (relative so floating label can be placed) */}
        <div style={{ position: 'relative' }}>
          {/* Floating hint label over top border */}
          <div
            style={{
              position: 'absolute',
              top: -10,
              right: 16,
              padding: '0 8px',
              background: 'var(--bg)',
              fontFamily: 'var(--font-body)',
              fontWeight: 400,
              fontSize: 10,
              lineHeight: '15px',
              color: 'var(--fg-muted)',
              pointerEvents: 'none',
              whiteSpace: 'nowrap',
            }}
          >
            Enter to send • Shift+Enter for newline
          </div>

          {/* Input row */}
          <div
            style={{
              display: 'flex',
              flexDirection: 'row',
              alignItems: 'flex-end',
              gap: 16,
              padding: 16,
              background: 'var(--bg-card-hover)',
              border: '1px solid rgba(var(--separator-rgb),0.3)',
            }}
          >
            <textarea
              ref={textareaRef}
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Query the node..."
              rows={1}
              disabled={isLoading}
              style={{
                flex: 1,
                border: 'none',
                outline: 'none',
                resize: 'none',
                fontFamily: 'var(--font-heading)',
                fontWeight: 400,
                fontSize: 16,
                lineHeight: '20px',
                background: 'transparent',
                color: 'var(--fg)',
                overflowY: 'hidden',
              }}
            />

            {/* Decorative attach icon */}
            <div
              style={{
                width: 12,
                height: 20,
                background: 'var(--fg-dim)',
                flexShrink: 0,
                alignSelf: 'center',
                opacity: 0.5,
              }}
            />

            {/* Send button */}
            <button
              onClick={() => void sendMessage(input)}
              disabled={!input.trim() || isLoading}
              style={{
                width: 40,
                height: 40,
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                flexShrink: 0,
                fontSize: 18,
                padding: 0,
              }}
            >
              ↵
            </button>
          </div>
        </div>

      </footer>
    </div>
  );
}
