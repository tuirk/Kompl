'use client';

/**
 * AppleNotesConnector — /onboarding/apple-notes
 *
 * Guides the user through exporting Apple Notes (Mac or iPhone/iPad),
 * then uploads the resulting files. No programmatic access needed.
 *
 * File routing on ingest:
 *   .md  → connector: 'text' (already markdown, skip conversion)
 *   everything else (.html, .txt, .pdf, .rtfd) → connector: 'file-upload' (MarkItDown)
 *
 * No backend changes — existing /api/onboarding/upload and
 * /api/onboarding/collect handle everything.
 */

import { useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  type ConnectorProps,
  navigateNext,
  navigateBack,
  stageItems,
  BottomNav,
} from './_shared';
import { toUserMessage } from '@/lib/service-errors';

interface UploadedFile {
  file_path: string;
  filename: string;
  size_bytes: number;
  mtime_ms: number;
}

const APPLE_NOTES_ACCEPT = '.md,.html,.htm,.txt,.pdf,.rtfd';

function isMdFile(f: File) {
  return f.name.toLowerCase().endsWith('.md');
}

function AppleNotesResumeBanner({ sessionId }: { sessionId: string }) {
  return (
    <div style={{
      marginBottom: 24,
      padding: '12px 16px',
      background: 'rgba(var(--accent-rgb), 0.08)',
      border: '1px solid rgba(var(--accent-rgb), 0.2)',
      display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 16,
    }}>
      <span style={{
        fontFamily: 'var(--font-mono)', fontSize: 11,
        letterSpacing: '0.5px', color: 'var(--fg-dim)',
      }}>
        Adding more Apple Notes to an existing session.
      </span>
      <a
        href={`/onboarding/review?session_id=${encodeURIComponent(sessionId)}`}
        style={{
          fontFamily: 'var(--font-mono)', fontSize: 10, letterSpacing: '1px',
          textTransform: 'uppercase', color: 'var(--accent)', textDecoration: 'none',
        }}
      >
        Review what you have →
      </a>
    </div>
  );
}

export default function AppleNotesConnector({
  sessionId,
  connectors,
  connectorIdx,
  showToast,
  mode,
}: ConnectorProps) {
  const router = useRouter();
  const [selectedFiles, setSelectedFiles] = useState<File[]>([]);
  const [isDragging, setIsDragging] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [saving, setSaving] = useState(false);
  const [loadingMsg, setLoadingMsg] = useState('');

  function addFiles(fileList: FileList | null) {
    if (!fileList) return;
    const valid = Array.from(fileList).filter(f => {
      const name = f.name.toLowerCase();
      return (
        name.endsWith('.md') ||
        name.endsWith('.html') ||
        name.endsWith('.htm') ||
        name.endsWith('.txt') ||
        name.endsWith('.pdf') ||
        name.endsWith('.rtfd')
      );
    });
    setSelectedFiles(prev => [...prev, ...valid].slice(0, 50));
  }

  function removeFile(idx: number) {
    setSelectedFiles(prev => prev.filter((_, i) => i !== idx));
  }

  async function handleIngest() {
    if (selectedFiles.length === 0) {
      showToast('Select at least one file.', 'error');
      return;
    }
    setSaving(true);

    const mdFiles = selectedFiles.filter(isMdFile);
    const otherFiles = selectedFiles.filter(f => !isMdFile(f));

    // Phase A: .md files → stage as connector='text' (already markdown)
    if (mdFiles.length > 0) {
      setLoadingMsg(`Staging ${mdFiles.length} note${mdFiles.length !== 1 ? 's' : ''}…`);
      try {
        const readResults = await Promise.all(
          mdFiles.map(
            f => new Promise<{ file: File; markdown: string }>(
              (resolve, reject) => {
                const reader = new FileReader();
                reader.onload = e => resolve({ file: f, markdown: e.target?.result as string });
                reader.onerror = () => reject(new Error(`Failed to read ${f.name}`));
                reader.readAsText(f);
              }
            )
          )
        );
        await stageItems(
          sessionId,
          'text',
          readResults.map(({ file, markdown }) => {
            const excerpt = markdown.split('\n').find((l) => l.trim())?.trim().slice(0, 120) ?? '';
            return {
              markdown,
              title_hint: file.name.replace(/\.md$/i, ''),
              source_type_hint: 'note',
              display: {
                kind: 'text',
                source_origin: 'apple-notes',
                filename: file.name,
                excerpt,
                line_count: markdown.split('\n').length,
              },
            };
          }),
        );
      } catch (e) {
        showToast(toUserMessage(e instanceof Error ? e.message : 'stage_failed'), 'error');
        setSaving(false);
        return;
      }
    }

    // Phase B: non-md files → /api/onboarding/upload → stage as connector='file-upload'
    if (otherFiles.length > 0) {
      setLoadingMsg(`Uploading ${otherFiles.length} file${otherFiles.length !== 1 ? 's' : ''}…`);
      try {
        const fd = new FormData();
        for (const f of otherFiles) fd.append('files', f);

        const uploadRes = await fetch('/api/onboarding/upload', { method: 'POST', body: fd });
        const uploadBody = await uploadRes.json() as {
          files: UploadedFile[];
          failed: { filename: string; error: string }[];
          error?: string;
          error_code?: string;
        };

        if (!uploadRes.ok || uploadBody.files.length === 0) {
          const msg = uploadBody.error_code ? toUserMessage(uploadBody.error_code) : uploadBody.error ?? 'Upload failed';
          showToast(msg, 'error');
          setSaving(false);
          return;
        }
        if (uploadBody.failed.length > 0) {
          showToast(`${uploadBody.failed.length} file(s) could not be saved — continuing with the rest.`);
        }

        setLoadingMsg(`Staging ${uploadBody.files.length} file${uploadBody.files.length !== 1 ? 's' : ''}…`);
        await stageItems(
          sessionId,
          'file-upload',
          uploadBody.files.map(({ file_path, filename, size_bytes, mtime_ms }) => ({
            file_path,
            title_hint: filename.replace(/\.[^.]+$/, ''),
            display: {
              kind: 'file-upload',
              source_origin: 'apple-notes',
              filename,
              size_bytes,
              mtime_ms,
              ext: filename.includes('.') ? filename.split('.').pop()?.toLowerCase() ?? '' : '',
            },
          })),
        );
      } catch (e) {
        showToast(toUserMessage(e instanceof Error ? e.message : 'stage_failed'), 'error');
        setSaving(false);
        return;
      }
    }

    navigateNext(sessionId, connectors, connectorIdx, router, mode);
  }

  // ── Loading state ─────────────────────────────────────────────────────────────
  if (saving) {
    return (
      <div style={{ textAlign: 'center', padding: '2rem 0', color: 'var(--fg-muted)' }}>
        <p>⏳ {loadingMsg}</p>
      </div>
    );
  }

  // ── Main screen ───────────────────────────────────────────────────────────────
  return (
    <div>
      {mode === 'resume' && <AppleNotesResumeBanner sessionId={sessionId} />}

      {/* Step 1 — Export guide */}
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ margin: '0 0 1rem', fontSize: '1rem', fontWeight: 600 }}>
          Step 1 — Export your notes
        </h2>

        <div style={{ display: 'flex', gap: '1rem', flexWrap: 'wrap' }}>
          {/* Card A — Mac */}
          <div
            style={{
              flex: '1 1 260px',
              padding: '1.25rem 1.5rem',
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--bg-card)',
            }}
          >
            <p style={{ margin: '0 0 0.75rem', fontWeight: 600, fontSize: '0.95rem' }}>
              🖥 Mac <span style={{ fontWeight: 400, fontSize: '0.8rem', color: 'var(--fg-muted)' }}>(recommended)</span>
            </p>
            <ol style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.88rem', color: 'var(--fg-muted)', lineHeight: 1.7 }}>
              <li>
                Download{' '}
                <a
                  href="https://github.com/kzaremski/apple-notes-exporter"
                  target="_blank"
                  rel="noopener noreferrer"
                  style={{ color: 'var(--accent)' }}
                >
                  Apple Notes Exporter
                </a>{' '}
                (free, open source)
              </li>
              <li>Open it → select your notes → export as Markdown</li>
              <li style={{ marginTop: '0.5rem', listStyle: 'none', marginLeft: '-1.2rem', color: 'var(--fg-dim)', fontSize: '0.82rem' }}>
                Or on macOS Sequoia+: open Notes app → select a note → File → Export as → Markdown
              </li>
            </ol>
          </div>

          {/* Card B — iPhone / iPad */}
          <div
            style={{
              flex: '1 1 260px',
              padding: '1.25rem 1.5rem',
              border: '1px solid var(--border)',
              borderRadius: 8,
              background: 'var(--bg-card)',
            }}
          >
            <p style={{ margin: '0 0 0.75rem', fontWeight: 600, fontSize: '0.95rem' }}>
              📱 iPhone / iPad
            </p>
            <ol style={{ margin: 0, paddingLeft: '1.2rem', fontSize: '0.88rem', color: 'var(--fg-muted)', lineHeight: 1.7 }}>
              <li>Select your notes → tap <strong>Share</strong> → <strong>Save to Files</strong></li>
              <li>This exports them as PDF or text files — upload those below</li>
            </ol>
          </div>
        </div>

        <p style={{ margin: '0.75rem 0 0', fontSize: '0.82rem', color: 'var(--fg-dim)' }}>
          We accept .md, .html, .txt, .pdf, and .rtfd files.
        </p>
      </div>

      {/* Step 2 — Upload */}
      <div style={{ marginBottom: '2rem' }}>
        <h2 style={{ margin: '0 0 1rem', fontSize: '1rem', fontWeight: 600 }}>
          Step 2 — Upload your exported notes
        </h2>

        <div
          onDragOver={e => { e.preventDefault(); setIsDragging(true); }}
          onDragLeave={() => setIsDragging(false)}
          onDrop={e => { e.preventDefault(); setIsDragging(false); addFiles(e.dataTransfer.files); }}
          onClick={() => fileInputRef.current?.click()}
          style={{
            border: `2px dashed ${isDragging ? 'var(--accent)' : 'var(--border)'}`,
            borderRadius: 8,
            padding: '2rem',
            textAlign: 'center',
            cursor: 'pointer',
            background: isDragging ? 'var(--bg-card-hover)' : 'var(--bg-card)',
            color: 'var(--fg-muted)',
            marginBottom: '1rem',
          }}
        >
          <div style={{ fontSize: '2rem', marginBottom: '0.5rem' }}>📱</div>
          <div>Drag files here or <span style={{ color: 'var(--accent)' }}>click to browse</span></div>
          <div style={{ fontSize: '0.8rem', marginTop: '0.3rem', color: 'var(--fg-dim)' }}>
            .md, .html, .txt, .pdf, .rtfd · up to 50 files
          </div>
        </div>

        <input
          ref={fileInputRef}
          type="file"
          multiple
          accept={APPLE_NOTES_ACCEPT}
          style={{ display: 'none' }}
          onChange={e => addFiles(e.target.files)}
        />

        {selectedFiles.length > 0 && (
          <div style={{ marginBottom: '1rem' }}>
            <p style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', marginBottom: '0.5rem' }}>
              {selectedFiles.length} file{selectedFiles.length !== 1 ? 's' : ''} selected
              {selectedFiles.length >= 50 && ' (max 50)'}
            </p>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: '0.4rem' }}>
              {selectedFiles.map((f, i) => (
                <span
                  key={i}
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    gap: '0.3rem',
                    padding: '0.2rem 0.6rem',
                    background: 'var(--bg-card)',
                    border: '1px solid var(--border)',
                    borderRadius: 999,
                    fontSize: '0.8rem',
                  }}
                >
                  {f.name.slice(0, 40)}{f.name.length > 40 ? '…' : ''}
                  <button
                    onClick={e => { e.stopPropagation(); removeFile(i); }}
                    style={{
                      background: 'none',
                      border: 'none',
                      cursor: 'pointer',
                      color: 'var(--fg-dim)',
                      padding: 0,
                      lineHeight: 1,
                      fontSize: '0.9rem',
                    }}
                  >×</button>
                </span>
              ))}
            </div>
          </div>
        )}
      </div>

      <BottomNav
        phase={saving ? 'loading' : 'idle'}
        hasInput={selectedFiles.length > 0}
        onIngest={handleIngest}
        onSkip={() => navigateNext(sessionId, connectors, connectorIdx, router, mode)}
        onBack={() => navigateBack(sessionId, connectors, connectorIdx, router, mode)}
      />
    </div>
  );
}
