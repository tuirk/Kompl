'use client';

/**
 * Chat agent page — ask questions about your wiki.
 *
 * Session lifecycle:
 *   - sessionId = randomUUID() on component mount (new session per page visit)
 *   - "New conversation" resets sessionId + messages
 *
 * Retrieval strategy (server-side, in /api/chat):
 *   - Small wikis (< 6k estimated tokens): index-first (LLM picks pages)
 *   - Large wikis: hybrid FTS5 + vector similarity with weighted scoring
 *
 * Citations: [Page Title] in answers link to /wiki/{page_id}
 */

import { useEffect, useMemo, useRef, useState } from 'react';
import Link from 'next/link';
import type { ChatMessage, Citation } from '@/lib/chat-types';

// ---------------------------------------------------------------------------
// Citation link rendering
// ---------------------------------------------------------------------------

function renderAnswer(answer: string, citations: Citation[]) {
  const citationMap = new Map(
    citations.map((c) => [c.page_title.toLowerCase(), c]),
  );

  const parts = answer.split(/(\[[^\]]+\])/g);
  return parts.map((part, i) => {
    const match = part.match(/^\[([^\]]+)\]$/);
    if (match) {
      const title = match[1];
      const citation = citationMap.get(title.toLowerCase());
      if (citation) {
        return (
          <Link
            key={i}
            href={`/wiki/${citation.page_id}`}
            style={{ color: 'var(--accent)', textDecoration: 'underline' }}
          >
            {title}
          </Link>
        );
      }
    }
    return <span key={i}>{part}</span>;
  });
}

// ---------------------------------------------------------------------------
// Typing indicator
// ---------------------------------------------------------------------------

function TypingIndicator() {
  return (
    <div
      style={{
        display: 'flex',
        gap: '4px',
        alignItems: 'center',
        padding: '0.75rem 1rem',
      }}
    >
      {[0, 1, 2].map((i) => (
        <span
          key={i}
          style={{
            width: 7,
            height: 7,
            borderRadius: '50%',
            background: 'var(--fg-muted, #888)',
            animation: `pulse 1.2s ease-in-out ${i * 0.2}s infinite`,
            display: 'inline-block',
          }}
        />
      ))}
      <style>{`
        @keyframes pulse {
          0%, 80%, 100% { opacity: 0.3; transform: scale(0.8); }
          40% { opacity: 1; transform: scale(1); }
        }
      `}</style>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Example questions
// ---------------------------------------------------------------------------

const EXAMPLE_QUESTIONS = [
  'What topics does my knowledge base cover?',
  'Summarise the key entities in my wiki.',
  'What are the main concepts I have compiled?',
  'Are there any contradictions between my sources?',
];

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

  // Auto-scroll to latest message
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, isLoading]);

  // Auto-resize textarea
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;
    el.style.height = 'auto';
    const lineHeight = 24;
    const maxHeight = lineHeight * 4;
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
        maxWidth: 780,
        margin: '0 auto',
        padding: '0 1.5rem',
        display: 'flex',
        flexDirection: 'column',
        height: '100dvh',
      }}
    >
      {/* Header */}
      <header
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '1.25rem 0 1rem',
          borderBottom: '1px solid var(--border, #e5e7eb)',
          flexShrink: 0,
        }}
      >
        <Link
          href="/"
          style={{ color: 'var(--fg-muted, #888)', textDecoration: 'none', fontSize: '0.9rem' }}
        >
          ← Dashboard
        </Link>
        <span style={{ fontWeight: 600, fontSize: '1rem' }}>Ask your wiki</span>
        <button
          onClick={newConversation}
          style={{
            background: 'none',
            border: '1px solid var(--border, #e5e7eb)',
            borderRadius: 6,
            padding: '0.3rem 0.75rem',
            fontSize: '0.85rem',
            cursor: 'pointer',
            color: 'var(--fg-muted, #888)',
          }}
        >
          New conversation
        </button>
      </header>

      {/* Messages */}
      <div
        style={{
          flex: 1,
          overflowY: 'auto',
          padding: '1.5rem 0',
          display: 'flex',
          flexDirection: 'column',
          gap: '1rem',
        }}
      >
        {isEmpty && (
          <div
            style={{
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              flex: 1,
              gap: '1.5rem',
              paddingTop: '3rem',
            }}
          >
            <p style={{ color: 'var(--fg-muted, #888)', fontSize: '1rem', margin: 0 }}>
              Ask anything about your compiled wiki.
            </p>
            <div style={{ display: 'flex', flexDirection: 'column', gap: '0.5rem', width: '100%' }}>
              {EXAMPLE_QUESTIONS.map((q) => (
                <button
                  key={q}
                  onClick={() => void sendMessage(q)}
                  style={{
                    textAlign: 'left',
                    background: 'var(--bg-subtle, #f9fafb)',
                    border: '1px solid var(--border, #e5e7eb)',
                    borderRadius: 8,
                    padding: '0.65rem 1rem',
                    cursor: 'pointer',
                    fontSize: '0.9rem',
                    color: 'var(--fg, #111)',
                  }}
                >
                  {q}
                </button>
              ))}
            </div>
          </div>
        )}

        {messages.map((msg) => (
          <div
            key={msg.id}
            style={{
              display: 'flex',
              justifyContent: msg.role === 'user' ? 'flex-end' : 'flex-start',
            }}
          >
            <div
              style={{
                maxWidth: '80%',
                padding: '0.75rem 1rem',
                borderRadius: msg.role === 'user' ? '18px 18px 4px 18px' : '18px 18px 18px 4px',
                background:
                  msg.role === 'user'
                    ? 'var(--accent, #0070f3)'
                    : 'var(--bg-subtle, #f9fafb)',
                color: msg.role === 'user' ? '#fff' : 'var(--fg, #111)',
                border: msg.role === 'assistant' ? '1px solid var(--border, #e5e7eb)' : 'none',
                fontSize: '0.95rem',
                lineHeight: 1.6,
                whiteSpace: 'pre-wrap',
                wordBreak: 'break-word',
              }}
            >
              {msg.role === 'assistant' && msg.citations.length > 0
                ? renderAnswer(msg.content, msg.citations)
                : msg.content}
            </div>
          </div>
        ))}

        {isLoading && (
          <div style={{ display: 'flex', justifyContent: 'flex-start' }}>
            <div
              style={{
                border: '1px solid var(--border, #e5e7eb)',
                borderRadius: '18px 18px 18px 4px',
                background: 'var(--bg-subtle, #f9fafb)',
              }}
            >
              <TypingIndicator />
            </div>
          </div>
        )}

        <div ref={bottomRef} />
      </div>

      {/* Input */}
      <div
        style={{
          borderTop: '1px solid var(--border, #e5e7eb)',
          padding: '1rem 0 1.5rem',
          flexShrink: 0,
        }}
      >
        <div
          style={{
            display: 'flex',
            gap: '0.5rem',
            alignItems: 'flex-end',
            border: '1px solid var(--border, #e5e7eb)',
            borderRadius: 12,
            padding: '0.5rem 0.5rem 0.5rem 1rem',
            background: '#fff',
          }}
        >
          <textarea
            ref={textareaRef}
            value={input}
            onChange={(e) => setInput(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Ask your wiki…  (Enter to send, Shift+Enter for newline)"
            rows={1}
            disabled={isLoading}
            style={{
              flex: 1,
              border: 'none',
              outline: 'none',
              resize: 'none',
              fontSize: '0.95rem',
              lineHeight: '24px',
              background: 'transparent',
              color: 'var(--fg, #111)',
              fontFamily: 'inherit',
              overflowY: 'hidden',
            }}
          />
          <button
            onClick={() => void sendMessage(input)}
            disabled={!input.trim() || isLoading}
            style={{
              background: 'var(--accent, #0070f3)',
              color: '#fff',
              border: 'none',
              borderRadius: 8,
              padding: '0.45rem 1rem',
              fontSize: '0.9rem',
              cursor: input.trim() && !isLoading ? 'pointer' : 'not-allowed',
              opacity: input.trim() && !isLoading ? 1 : 0.5,
              flexShrink: 0,
            }}
          >
            Send
          </button>
        </div>
      </div>
    </div>
  );
}
