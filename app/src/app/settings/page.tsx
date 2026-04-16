'use client';

/**
 * /settings — App settings page.
 *
 * Settings:
 *   - auto_approve              — commit wiki changes immediately vs. queue as drafts
 *   - digest_enabled            — send weekly Telegram digest every Sunday 00:00 UTC
 *   - digest_telegram_token     — Telegram bot token (masked in GET, write-only)
 *   - digest_telegram_chat_id   — Telegram chat ID for the bot to send to
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';

export default function SettingsPage() {
  const router = useRouter();

  const [autoApprove, setAutoApprove] = useState<boolean | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);

  const [relatedMinSources, setRelatedMinSources] = useState<number | null>(null);
  const [relatedSaving, setRelatedSaving] = useState(false);
  const [relatedSaved, setRelatedSaved] = useState(false);

  const [exportLoading, setExportLoading] = useState<'markdown' | 'obsidian' | 'json' | 'kompl' | null>(null);

  const [importFile, setImportFile] = useState<File | null>(null);
  const [importLoading, setImportLoading] = useState(false);
  const [importError, setImportError] = useState<string | null>(null);
  const [importSuccess, setImportSuccess] = useState(false);

  const [staleThreshold, setStaleThreshold] = useState<number | null>(null);
  const [staleSaving, setStaleSaving] = useState(false);
  const [staleSaved, setStaleSaved] = useState(false);

  const [minSourceChars, setMinSourceChars] = useState<number | null>(null);
  const [minSourceCharsSaving, setMinSourceCharsSaving] = useState(false);
  const [minSourceCharsSaved, setMinSourceCharsSaved] = useState(false);

  const [minDraftChars, setMinDraftChars] = useState<number | null>(null);
  const [minDraftCharsSaving, setMinDraftCharsSaving] = useState(false);
  const [minDraftCharsSaved, setMinDraftCharsSaved] = useState(false);

  const [deploymentMode, setDeploymentModeState] = useState<'personal-device' | 'always-on' | null>(null);
  const [deploymentSaving, setDeploymentSaving] = useState(false);
  const [deploymentSaved, setDeploymentSaved] = useState(false);
  const [lastLintAt, setLastLintAt] = useState<string | null>(null);
  const [lastBackupAt, setLastBackupAt] = useState<string | null>(null);

  const [lintEnabled, setLintEnabledState] = useState<boolean | null>(null);
  const [lintSaving, setLintSaving] = useState(false);
  const [lintSaved, setLintSaved] = useState(false);
  const [lintRunning, setLintRunning] = useState(false);

  interface MissingCrossRef { entity_text: string; mention_count: number; }
  interface LintLastResult {
    orphan_pages?: number;
    stale_pages?: number;
    missing_cross_refs?: MissingCrossRef[];
    dead_provenance?: number;
    contradiction_count?: number;
    run_duration_ms?: number;
  }
  const [lintLastResult, setLintLastResult] = useState<LintLastResult | null>(null);

  const [digestEnabled, setDigestEnabled] = useState<boolean | null>(null);
  const [digestSaving, setDigestSaving] = useState(false);
  const [digestSaved, setDigestSaved] = useState(false);
  const [digestToken, setDigestToken] = useState('');
  const [digestTokenIsSet, setDigestTokenIsSet] = useState(false);
  const [digestTokenSaving, setDigestTokenSaving] = useState(false);
  const [digestTokenSaved, setDigestTokenSaved] = useState(false);
  const [digestShowToken, setDigestShowToken] = useState(false);
  const [digestChatId, setDigestChatId] = useState('');
  const [digestChatIdSaving, setDigestChatIdSaving] = useState(false);
  const [digestChatIdSaved, setDigestChatIdSaved] = useState(false);
  const [digestShowChatId, setDigestShowChatId] = useState(false);

  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json())
      .then((data: {
        auto_approve: boolean;
        related_pages_min_sources: number;
        stale_threshold_days: number;
        digest_enabled: boolean;
        digest_telegram_token: string | null;
        digest_telegram_chat_id: string | null;
        lint_enabled: boolean;
        lint_last_result: LintLastResult | null;
        deployment_mode: 'personal-device' | 'always-on';
        last_lint_at: string | null;
        last_backup_at: string | null;
        min_source_chars: number;
        min_draft_chars: number;
      }) => {
        setAutoApprove(data.auto_approve);
        setRelatedMinSources(data.related_pages_min_sources);
        setStaleThreshold(data.stale_threshold_days);
        setDigestEnabled(data.digest_enabled);
        setDigestTokenIsSet(data.digest_telegram_token !== null);
        setDigestChatId(data.digest_telegram_chat_id ?? '');
        setLintEnabledState(data.lint_enabled);
        setLintLastResult(data.lint_last_result);
        setDeploymentModeState(data.deployment_mode);
        setLastLintAt(data.last_lint_at);
        setLastBackupAt(data.last_backup_at);
        setMinSourceChars(data.min_source_chars);
        setMinDraftChars(data.min_draft_chars);
      });
  }, []);

  async function toggle() {
    if (autoApprove === null) return;
    const newVal = !autoApprove;
    setSaving(true);
    setSaved(false);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ auto_approve: newVal }),
    });
    setAutoApprove(newVal);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function saveRelatedMinSources() {
    if (relatedMinSources === null) return;
    setRelatedSaving(true);
    setRelatedSaved(false);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ related_pages_min_sources: relatedMinSources }),
    });
    setRelatedSaving(false);
    setRelatedSaved(true);
    setTimeout(() => setRelatedSaved(false), 2000);
  }

  async function saveStaleThreshold() {
    if (staleThreshold === null) return;
    setStaleSaving(true);
    setStaleSaved(false);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ stale_threshold_days: staleThreshold }),
    });
    setStaleSaving(false);
    setStaleSaved(true);
    setTimeout(() => setStaleSaved(false), 2000);
  }

  async function handleExport(format: 'markdown' | 'obsidian' | 'json' | 'kompl') {
    setExportLoading(format);
    try {
      const res = await fetch(`/api/export?format=${format}`);
      const blob = await res.blob();
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download =
        format === 'json'
          ? 'kompl-wiki-export.json'
          : format === 'kompl'
          ? 'kompl-export.kompl.zip'
          : `kompl-wiki-${format}.zip`;
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      if (format === 'kompl') setLastBackupAt(new Date().toISOString());
    } finally {
      setExportLoading(null);
    }
  }

  async function handleImport() {
    if (!importFile) return;
    setImportLoading(true);
    setImportError(null);
    try {
      const fd = new FormData();
      fd.append('file', importFile);
      const res = await fetch('/api/import', { method: 'POST', body: fd });
      if (res.status === 409) {
        setImportError('Wiki is not empty. Delete all data before importing.');
        return;
      }
      if (!res.ok) {
        const body = await res.json() as { error?: string };
        setImportError(body.error ?? 'Import failed');
        return;
      }
      setImportSuccess(true);
      setTimeout(() => { router.push('/wiki'); }, 1500);
    } finally {
      setImportLoading(false);
    }
  }

  async function toggleDigest() {
    if (digestEnabled === null || digestSaving) return;
    const newVal = !digestEnabled;
    setDigestSaving(true);
    setDigestSaved(false);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ digest_enabled: newVal }),
    });
    setDigestEnabled(newVal);
    setDigestSaving(false);
    setDigestSaved(true);
    setTimeout(() => setDigestSaved(false), 2000);
  }

  async function saveDigestToken() {
    if (!digestToken.trim() || digestTokenSaving) return;
    setDigestTokenSaving(true);
    setDigestTokenSaved(false);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ digest_telegram_token: digestToken.trim() }),
    });
    setDigestToken('');
    setDigestTokenIsSet(true);
    setDigestShowToken(false);
    setDigestTokenSaving(false);
    setDigestTokenSaved(true);
    setTimeout(() => setDigestTokenSaved(false), 2000);
  }

  async function saveDigestChatId() {
    if (!digestChatId.trim() || digestChatIdSaving) return;
    setDigestChatIdSaving(true);
    setDigestChatIdSaved(false);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ digest_telegram_chat_id: digestChatId.trim() }),
    });
    setDigestChatIdSaving(false);
    setDigestChatIdSaved(true);
    setTimeout(() => setDigestChatIdSaved(false), 2000);
  }

  async function toggleDeploymentMode() {
    if (deploymentMode === null || deploymentSaving) return;
    const newVal = deploymentMode === 'personal-device' ? 'always-on' : 'personal-device';
    setDeploymentSaving(true);
    setDeploymentSaved(false);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ deployment_mode: newVal }),
    });
    setDeploymentModeState(newVal);
    setDeploymentSaving(false);
    setDeploymentSaved(true);
    setTimeout(() => setDeploymentSaved(false), 2000);
  }

  function formatRelativeTime(iso: string | null): string {
    if (!iso) return 'Never';
    const diff = Date.now() - new Date(iso).getTime();
    if (diff < 0) return 'Just now';
    const h = Math.floor(diff / 3_600_000);
    if (h < 1) return 'Less than an hour ago';
    if (h < 24) return `${h}h ago`;
    const d = Math.floor(h / 24);
    return d === 1 ? '1 day ago' : `${d} days ago`;
  }

  async function toggleLint() {
    if (lintEnabled === null || lintSaving) return;
    const newVal = !lintEnabled;
    setLintSaving(true);
    setLintSaved(false);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ lint_enabled: newVal }),
    });
    setLintEnabledState(newVal);
    setLintSaving(false);
    setLintSaved(true);
    setTimeout(() => setLintSaved(false), 2000);
  }

  async function runLintNow() {
    if (lintRunning) return;
    setLintRunning(true);
    try {
      const res = await fetch('/api/wiki/lint-pass', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ manual: true }),
      });
      if (res.ok) {
        // Route returns arrays of ids; normalize to counts to match LintLastResult
        // (which mirrors the activity_log details shape written by the same route).
        const data = (await res.json()) as {
          orphan_pages: string[];
          stale_pages: string[];
          missing_cross_refs: MissingCrossRef[];
          dead_provenance: number;
          contradictions?: unknown[];
          run_duration_ms: number;
        };
        setLintLastResult({
          orphan_pages: data.orphan_pages.length,
          stale_pages: data.stale_pages.length,
          missing_cross_refs: data.missing_cross_refs,
          dead_provenance: data.dead_provenance,
          contradiction_count: data.contradictions?.length ?? 0,
          run_duration_ms: data.run_duration_ms,
        });
        setLastLintAt(new Date().toISOString());
      }
    } finally {
      setLintRunning(false);
    }
  }

  async function saveMinSourceChars() {
    if (minSourceChars === null) return;
    setMinSourceCharsSaving(true);
    setMinSourceCharsSaved(false);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ min_source_chars: minSourceChars }),
    });
    setMinSourceCharsSaving(false);
    setMinSourceCharsSaved(true);
    setTimeout(() => setMinSourceCharsSaved(false), 2000);
  }

  async function saveMinDraftChars() {
    if (minDraftChars === null) return;
    setMinDraftCharsSaving(true);
    setMinDraftCharsSaved(false);
    await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ min_draft_chars: minDraftChars }),
    });
    setMinDraftCharsSaving(false);
    setMinDraftCharsSaved(true);
    setTimeout(() => setMinDraftCharsSaved(false), 2000);
  }

  return (
    <main style={{ maxWidth: 1040, margin: '0 auto', padding: '3rem 1.5rem calc(5rem + 32px)' }}>
      <div style={{ marginBottom: '2rem' }}>
        <Link
          href="/"
          style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontFamily: 'var(--font-mono)', fontSize: 10,
            textTransform: 'uppercase', letterSpacing: '1px',
            color: 'var(--fg-dim)', textDecoration: 'none',
            marginBottom: 12,
          }}
        >
          ← Dashboard
        </Link>
        <h1 style={{ margin: '0.5rem 0 0', fontSize: '1.6rem' }}>Settings</h1>
      </div>

      <section
        style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflow: 'hidden',
        }}
      >
        <div
          style={{
            padding: '1.25rem 1.5rem',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '1.5rem',
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: '0.35rem' }}>
              Auto-approve wiki changes
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', lineHeight: 1.5 }}>
              When enabled, compiled pages are committed immediately to the wiki.
              When disabled, changes appear as drafts on your dashboard for review before publishing.
            </div>
          </div>
          <button
            className={autoApprove ? undefined : 'btn-outline'}
            onClick={() => void toggle()}
            disabled={autoApprove === null || saving}
            style={{
              flexShrink: 0,
              padding: '0.45rem 1rem',
              borderRadius: 20,
              fontSize: '0.85rem',
              opacity: autoApprove === null ? 0.5 : 1,
              minWidth: 80,
            }}
          >
            {autoApprove === null ? '…' : autoApprove ? 'ON' : 'OFF'}
          </button>
        </div>
        {saved && (
          <div
            style={{
              padding: '0.6rem 1.5rem',
              background: 'var(--success-bg, #ecfdf5)',
              borderTop: '1px solid var(--success-border, #a7f3d0)',
              color: 'var(--success, #059669)',
              fontSize: 13,
            }}
          >
            Saved.
          </div>
        )}
      </section>

      {/* Related pages threshold */}
      <section
        style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflow: 'hidden',
          marginTop: '1rem',
        }}
      >
        <div
          style={{
            padding: '1.25rem 1.5rem',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '1.5rem',
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: '0.35rem' }}>
              Related pages threshold
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', lineHeight: 1.5 }}>
              Show a "You might also read" panel on wiki pages once at least this many sources
              have been ingested. Uses embedding similarity — zero LLM cost.
              Set to <strong>0</strong> to always show.
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0 }}>
            <input
              type="number"
              min={0}
              step={1}
              value={relatedMinSources ?? ''}
              onChange={(e) => setRelatedMinSources(Math.max(0, parseInt(e.target.value || '0', 10)))}
              onBlur={() => void saveRelatedMinSources()}
              disabled={relatedMinSources === null || relatedSaving}
              style={{
                width: 72,
                padding: '0.45rem 0.6rem',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'var(--bg-card)',
                color: 'var(--fg)',
                fontSize: '0.9rem',
                textAlign: 'right',
                opacity: relatedMinSources === null ? 0.5 : 1,
              }}
            />
            <span style={{ fontSize: '0.85rem', color: 'var(--fg-dim)' }}>sources</span>
          </div>
        </div>
        {relatedSaved && (
          <div
            style={{
              padding: '0.6rem 1.5rem',
              background: 'var(--success-bg, #ecfdf5)',
              borderTop: '1px solid var(--success-border, #a7f3d0)',
              color: 'var(--success, #059669)',
              fontSize: 13,
            }}
          >
            Saved.
          </div>
        )}
      </section>

      {/* Entity Expansion — read-only, intentionally locked OFF */}
      <section
        style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflow: 'hidden',
          marginTop: '1rem',
          opacity: 0.75,
        }}
      >
        <div
          style={{
            padding: '1.25rem 1.5rem',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '1.5rem',
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: '0.35rem' }}>
              <span style={{ fontWeight: 600, fontSize: '0.95rem' }}>Entity Expansion</span>
              <span style={{
                fontFamily: 'var(--font-mono)', fontSize: 8, letterSpacing: '0.8px',
                textTransform: 'uppercase', color: 'var(--fg-dim)',
                border: '1px solid var(--border)', padding: '2px 6px',
              }}>
                Experimental
              </span>
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', lineHeight: 1.6, marginBottom: '0.75rem' }}>
              After every compile, Kompl scans extracted entities that have no wiki page yet
              — people, tools, concepts — and asks the LLM to generate a short stub page for each one.
              A single Wikipedia article can surface 80-100 entities. Without a hard cap this feature
              burns the entire daily LLM budget in a single compile run.
            </div>
            {/* Warning banner */}
            <div style={{
              display: 'flex', alignItems: 'flex-start', gap: 8,
              background: 'rgba(var(--warning-rgb),0.08)',
              border: '1px solid rgba(var(--warning-rgb),0.25)',
              padding: '0.6rem 0.85rem',
              borderRadius: 4,
            }}>
              <span style={{ fontSize: 13, flexShrink: 0, marginTop: 1 }}>⚠️</span>
              <span style={{ fontSize: '0.8rem', color: 'var(--warning)', lineHeight: 1.5 }}>
                <strong>This feature will skyrocket your LLM costs.</strong>{' '}
                Each stub page is a separate LLM call. At 80 entities per source,
                adding 5 sources in one session = up to 400 LLM calls for stubs alone.
                It is disabled and not configurable until a relevance-scoring system is
                in place to cap which entities are worth expanding.
              </span>
            </div>
          </div>
          <div
            style={{
              flexShrink: 0,
              padding: '0.45rem 1rem',
              borderRadius: 20,
              border: '1px solid var(--border)',
              background: 'var(--bg-card)',
              color: 'var(--fg-dim)',
              fontWeight: 600,
              fontSize: '0.85rem',
              cursor: 'not-allowed',
              userSelect: 'none',
              minWidth: 80,
              textAlign: 'center',
            }}
          >
            OFF
          </div>
        </div>
      </section>

      {/* Weekly Digest */}
      <section
        style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflow: 'hidden',
          marginTop: '1rem',
        }}
      >
        {/* Header row: title + toggle */}
        <div
          style={{
            padding: '1.25rem 1.5rem',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '1.5rem',
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: '0.35rem' }}>
              Weekly Digest
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', lineHeight: 1.5 }}>
              Get a summary of your wiki changes every Sunday at midnight (UTC).
              Digest won&apos;t send unless both Telegram fields are filled.
            </div>
          </div>
          <button
            className={digestEnabled ? undefined : 'btn-outline'}
            onClick={() => void toggleDigest()}
            disabled={digestEnabled === null || digestSaving}
            style={{
              flexShrink: 0,
              padding: '0.45rem 1rem',
              borderRadius: 20,
              fontSize: '0.85rem',
              opacity: digestEnabled === null ? 0.5 : 1,
              minWidth: 80,
            }}
          >
            {digestEnabled === null ? '…' : digestEnabled ? 'ON' : 'OFF'}
          </button>
        </div>

        {/* Telegram fields */}
        <div
          style={{
            padding: '0 1.5rem 1.25rem',
            display: 'flex',
            flexDirection: 'column',
            gap: '0.85rem',
          }}
        >
          {/* Bot Token */}
          <div>
            <label
              style={{
                display: 'block',
                fontSize: '0.8rem',
                fontWeight: 600,
                color: 'var(--fg-secondary)',
                marginBottom: '0.35rem',
                fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
              }}
            >
              Telegram Bot Token
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input
                type={digestShowToken ? 'text' : 'password'}
                placeholder={digestTokenIsSet ? '••••••••  (already set — paste to replace)' : 'Paste token from @BotFather'}
                value={digestToken}
                onChange={(e) => setDigestToken(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void saveDigestToken(); }}
                style={{
                  flex: 1,
                  padding: '0.45rem 0.7rem',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'var(--bg-card)',
                  color: 'var(--fg)',
                  fontSize: '0.9rem',
                  fontFamily: 'var(--font-mono)',
                }}
              />
              <button
                className="btn-outline"
                onClick={() => setDigestShowToken((v) => !v)}
                style={{ padding: '0.45rem 0.7rem', fontSize: '0.8rem', flexShrink: 0 }}
              >
                {digestShowToken ? 'Hide' : 'Show'}
              </button>
              <button
                onClick={() => void saveDigestToken()}
                disabled={!digestToken.trim() || digestTokenSaving}
                style={{
                  padding: '0.45rem 0.85rem',
                  fontSize: '0.85rem',
                  flexShrink: 0,
                  opacity: !digestToken.trim() ? 0.45 : 1,
                }}
              >
                {digestTokenSaving ? 'Saving…' : digestTokenSaved ? 'Saved' : 'Save'}
              </button>
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--fg-dim)', marginTop: '0.3rem' }}>
              Create a bot via @BotFather on Telegram, copy the token here.
            </div>
          </div>

          {/* Chat ID */}
          <div>
            <label
              style={{
                display: 'block',
                fontSize: '0.8rem',
                fontWeight: 600,
                color: 'var(--fg-secondary)',
                marginBottom: '0.35rem',
                fontFamily: 'var(--font-mono)',
                textTransform: 'uppercase',
                letterSpacing: '0.5px',
              }}
            >
              Telegram Chat ID
            </label>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center' }}>
              <input
                type={digestShowChatId ? 'text' : 'password'}
                placeholder="e.g. 123456789"
                value={digestChatId}
                onChange={(e) => setDigestChatId(e.target.value)}
                onKeyDown={(e) => { if (e.key === 'Enter') void saveDigestChatId(); }}
                style={{
                  flex: 1,
                  padding: '0.45rem 0.7rem',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'var(--bg-card)',
                  color: 'var(--fg)',
                  fontSize: '0.9rem',
                  fontFamily: 'var(--font-mono)',
                }}
              />
              <button
                className="btn-outline"
                onClick={() => setDigestShowChatId((v) => !v)}
                style={{ padding: '0.45rem 0.7rem', fontSize: '0.8rem', flexShrink: 0 }}
              >
                {digestShowChatId ? 'Hide' : 'Show'}
              </button>
              <button
                onClick={() => void saveDigestChatId()}
                disabled={!digestChatId.trim() || digestChatIdSaving}
                style={{
                  padding: '0.45rem 0.85rem',
                  fontSize: '0.85rem',
                  flexShrink: 0,
                  opacity: !digestChatId.trim() ? 0.45 : 1,
                }}
              >
                {digestChatIdSaving ? 'Saving…' : digestChatIdSaved ? 'Saved' : 'Save'}
              </button>
            </div>
            <div style={{ fontSize: '0.78rem', color: 'var(--fg-dim)', marginTop: '0.3rem' }}>
              Send /start to your bot, then visit api.telegram.org/bot{'<TOKEN>'}/getUpdates to find your chat ID.
            </div>
          </div>
        </div>

        {digestSaved && (
          <div
            style={{
              padding: '0.6rem 1.5rem',
              background: 'var(--success-bg, #ecfdf5)',
              borderTop: '1px solid var(--success-border, #a7f3d0)',
              color: 'var(--success, #059669)',
              fontSize: 13,
            }}
          >
            Saved.
          </div>
        )}
      </section>

      {/* Deployment Mode */}
      <section
        style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflow: 'hidden',
          marginTop: '1rem',
        }}
      >
        <div
          style={{
            padding: '1.25rem 1.5rem',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '1.5rem',
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: '0.35rem' }}>
              Deployment
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', lineHeight: 1.5 }}>
              {deploymentMode === 'always-on'
                ? 'Always-on server — lint and backup run on n8n\'s Monday 11:30 schedule.'
                : 'Personal device — lint and backup run automatically when Kompl starts (at most every 36 hours).'}
            </div>
            <div style={{ marginTop: '0.75rem', display: 'flex', gap: '1.5rem', fontSize: '0.8rem', color: 'var(--fg-dim)' }}>
              <span>Last lint: <span style={{ color: 'var(--fg-secondary)' }}>{formatRelativeTime(lastLintAt)}</span></span>
              <span>Last backup: <span style={{ color: 'var(--fg-secondary)' }}>{formatRelativeTime(lastBackupAt)}</span></span>
            </div>
          </div>
          <button
            className={deploymentMode === 'personal-device' ? undefined : 'btn-outline'}
            onClick={() => void toggleDeploymentMode()}
            disabled={deploymentMode === null || deploymentSaving}
            style={{
              flexShrink: 0,
              padding: '0.45rem 1rem',
              borderRadius: 20,
              fontSize: '0.85rem',
              opacity: deploymentMode === null ? 0.5 : 1,
              minWidth: 120,
              whiteSpace: 'nowrap',
            }}
          >
            {deploymentMode === null ? '…' : deploymentMode === 'personal-device' ? 'Personal device' : 'Always-on server'}
          </button>
        </div>
        {deploymentSaved && (
          <div
            style={{
              padding: '0.6rem 1.5rem',
              background: 'var(--success-bg, #ecfdf5)',
              borderTop: '1px solid var(--success-border, #a7f3d0)',
              color: 'var(--success, #059669)',
              fontSize: 13,
            }}
          >
            Saved.
          </div>
        )}
      </section>

      {/* Wiki Lint */}
      <section
        style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflow: 'hidden',
          marginTop: '1rem',
        }}
      >
        {/* Header row */}
        <div
          style={{
            padding: '1.25rem 1.5rem',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '1.5rem',
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: '0.35rem' }}>
              Wiki Health Checks
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', lineHeight: 1.5 }}>
              Scans for orphan pages, stale summaries, dead provenance links,
              entity names with no wiki page (3+ sources mention them), and
              contradictions between pages. Runs automatically every 6 hours when enabled.
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', flexShrink: 0, alignItems: 'center' }}>
            <button
              onClick={() => void runLintNow()}
              disabled={lintRunning}
              className="btn-outline"
              style={{ padding: '0.45rem 1rem', borderRadius: 20, fontSize: '0.85rem' }}
            >
              {lintRunning ? 'Running…' : 'Run Now'}
            </button>
            <button
              className={lintEnabled ? undefined : 'btn-outline'}
              onClick={() => void toggleLint()}
              disabled={lintEnabled === null || lintSaving}
              style={{
                flexShrink: 0,
                padding: '0.45rem 1rem',
                borderRadius: 20,
                fontSize: '0.85rem',
                opacity: lintEnabled === null ? 0.5 : 1,
                minWidth: 80,
              }}
            >
              {lintEnabled === null ? '…' : lintEnabled ? 'ON' : 'OFF'}
            </button>
          </div>
        </div>

        {lintSaved && (
          <div
            style={{
              padding: '0.6rem 1.5rem',
              background: 'var(--success-bg, #ecfdf5)',
              borderTop: '1px solid var(--success-border, #a7f3d0)',
              color: 'var(--success, #059669)',
              fontSize: 13,
            }}
          >
            Saved.
          </div>
        )}

        {/* Last run result */}
        {lintLastResult && !lintRunning && (
          <div
            style={{
              padding: '0 1.5rem 1.25rem',
              borderTop: '1px solid var(--border)',
            }}
          >
            <div
              style={{
                fontFamily: 'var(--font-mono)',
                fontSize: 10,
                textTransform: 'uppercase',
                letterSpacing: '0.8px',
                color: 'var(--fg-dim)',
                marginBottom: '0.75rem',
                paddingTop: '1rem',
              }}
            >
              Last run
              {lintLastResult.run_duration_ms !== undefined && (
                <span style={{ marginLeft: 8 }}>({lintLastResult.run_duration_ms}ms)</span>
              )}
            </div>

            {/* Summary row */}
            <div style={{ display: 'flex', gap: '1.5rem', flexWrap: 'wrap', marginBottom: '0.85rem' }}>
              {[
                { label: 'Orphans', value: lintLastResult.orphan_pages ?? 0 },
                { label: 'Stale', value: lintLastResult.stale_pages ?? 0 },
                { label: 'Missing cross-refs', value: lintLastResult.missing_cross_refs?.length ?? 0 },
                { label: 'Dead provenance', value: lintLastResult.dead_provenance ?? 0 },
                { label: 'Contradictions', value: lintLastResult.contradiction_count ?? 0 },
              ].map(({ label, value }) => (
                <div key={label} style={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 20, fontWeight: 700, color: value > 0 ? 'var(--fg)' : 'var(--fg-dim)' }}>
                    {value}
                  </span>
                  <span style={{ fontFamily: 'var(--font-mono)', fontSize: 9, textTransform: 'uppercase', letterSpacing: '0.6px', color: 'var(--fg-dim)' }}>
                    {label}
                  </span>
                </div>
              ))}
            </div>

            {/* Missing cross-refs list */}
            {(lintLastResult.missing_cross_refs?.length ?? 0) > 0 && (
              <div>
                <div
                  style={{
                    fontFamily: 'var(--font-mono)',
                    fontSize: 9,
                    textTransform: 'uppercase',
                    letterSpacing: '0.6px',
                    color: 'var(--fg-dim)',
                    marginBottom: '0.5rem',
                  }}
                >
                  Missing entity pages — search wiki to alias or create
                </div>
                <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                  {lintLastResult.missing_cross_refs!.map((ref) => (
                    <div key={ref.entity_text} style={{ display: 'flex', alignItems: 'center', gap: '0.75rem' }}>
                      <Link
                        href={`/wiki/search?q=${encodeURIComponent(ref.entity_text)}`}
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: '0.82rem',
                          color: 'var(--accent)',
                          textDecoration: 'none',
                        }}
                      >
                        {ref.entity_text}
                      </Link>
                      <span
                        style={{
                          fontFamily: 'var(--font-mono)',
                          fontSize: 10,
                          color: 'var(--fg-dim)',
                        }}
                      >
                        {ref.mention_count} source{ref.mention_count !== 1 ? 's' : ''}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        )}

        {lintRunning && (
          <div
            style={{
              padding: '0.75rem 1.5rem',
              borderTop: '1px solid var(--border)',
              fontFamily: 'var(--font-mono)',
              fontSize: 12,
              color: 'var(--fg-dim)',
            }}
          >
            Running checks…
          </div>
        )}
      </section>

      {/* Stale Source Alerts */}
      <section
        style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflow: 'hidden',
          marginTop: '1rem',
        }}
      >
        <div
          style={{
            padding: '1.25rem 1.5rem',
            display: 'flex',
            alignItems: 'flex-start',
            justifyContent: 'space-between',
            gap: '1.5rem',
          }}
        >
          <div style={{ flex: 1 }}>
            <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: '0.35rem' }}>
              Stale Source Alerts
            </div>
            <div style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', lineHeight: 1.5 }}>
              Show a reminder on the dashboard when sources haven&apos;t been updated in a while.
              Set to <strong>0</strong> to disable.
            </div>
          </div>
          <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0 }}>
            <input
              type="number"
              min={0}
              step={1}
              value={staleThreshold ?? ''}
              onChange={(e) => setStaleThreshold(Math.max(0, parseInt(e.target.value || '0', 10)))}
              onBlur={() => void saveStaleThreshold()}
              disabled={staleThreshold === null || staleSaving}
              style={{
                width: 72,
                padding: '0.45rem 0.6rem',
                borderRadius: 6,
                border: '1px solid var(--border)',
                background: 'var(--bg-card)',
                color: 'var(--fg)',
                fontSize: '0.9rem',
                textAlign: 'right',
                opacity: staleThreshold === null ? 0.5 : 1,
              }}
            />
            <span style={{ fontSize: '0.85rem', color: 'var(--fg-dim)' }}>days</span>
          </div>
        </div>
        {staleSaved && (
          <div
            style={{
              padding: '0.6rem 1.5rem',
              background: 'var(--success-bg, #ecfdf5)',
              borderTop: '1px solid var(--success-border, #a7f3d0)',
              color: 'var(--success, #059669)',
              fontSize: 13,
            }}
          >
            Saved.
          </div>
        )}
      </section>

      {/* Compilation Quality */}
      <section
        style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflow: 'hidden',
          marginTop: '1rem',
        }}
      >
        <div style={{ padding: '1.25rem 1.5rem' }}>
          <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: '0.85rem' }}>
            Compilation Quality
          </div>

          {/* Min source chars */}
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: '1.5rem',
              paddingBottom: '1rem',
              borderBottom: '1px solid var(--border)',
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '0.9rem', fontWeight: 500, marginBottom: '0.3rem' }}>
                Minimum source length for wiki page
              </div>
              <div style={{ fontSize: '0.82rem', color: 'var(--fg-muted)', lineHeight: 1.5 }}>
                Sources shorter than this get extracted but won&apos;t have their own summary page.
                Tweets, error pages, and short scrapes are filtered here. Set to <strong>0</strong> to disable.
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0 }}>
              <input
                type="number"
                min={0}
                step={50}
                value={minSourceChars ?? ''}
                onChange={(e) => setMinSourceChars(Math.max(0, parseInt(e.target.value || '0', 10)))}
                onBlur={() => void saveMinSourceChars()}
                disabled={minSourceChars === null || minSourceCharsSaving}
                style={{
                  width: 80,
                  padding: '0.45rem 0.6rem',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'var(--bg-card)',
                  color: 'var(--fg)',
                  fontSize: '0.9rem',
                  textAlign: 'right',
                  opacity: minSourceChars === null ? 0.5 : 1,
                }}
              />
              <span style={{ fontSize: '0.85rem', color: 'var(--fg-dim)' }}>chars</span>
            </div>
          </div>

          {/* Min draft chars */}
          <div
            style={{
              display: 'flex',
              alignItems: 'flex-start',
              justifyContent: 'space-between',
              gap: '1.5rem',
              paddingTop: '1rem',
            }}
          >
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: '0.9rem', fontWeight: 500, marginBottom: '0.3rem' }}>
                Minimum draft length to commit
              </div>
              <div style={{ fontSize: '0.82rem', color: 'var(--fg-muted)', lineHeight: 1.5 }}>
                If the AI produces a draft shorter than this, it won&apos;t be committed.
                The draft is logged so you can review it. Set to <strong>0</strong> to disable.
              </div>
            </div>
            <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'center', flexShrink: 0 }}>
              <input
                type="number"
                min={0}
                step={50}
                value={minDraftChars ?? ''}
                onChange={(e) => setMinDraftChars(Math.max(0, parseInt(e.target.value || '0', 10)))}
                onBlur={() => void saveMinDraftChars()}
                disabled={minDraftChars === null || minDraftCharsSaving}
                style={{
                  width: 80,
                  padding: '0.45rem 0.6rem',
                  borderRadius: 6,
                  border: '1px solid var(--border)',
                  background: 'var(--bg-card)',
                  color: 'var(--fg)',
                  fontSize: '0.9rem',
                  textAlign: 'right',
                  opacity: minDraftChars === null ? 0.5 : 1,
                }}
              />
              <span style={{ fontSize: '0.85rem', color: 'var(--fg-dim)' }}>chars</span>
            </div>
          </div>
        </div>
        {(minSourceCharsSaved || minDraftCharsSaved) && (
          <div
            style={{
              padding: '0.6rem 1.5rem',
              background: 'var(--success-bg, #ecfdf5)',
              borderTop: '1px solid var(--success-border, #a7f3d0)',
              color: 'var(--success, #059669)',
              fontSize: 13,
            }}
          >
            Saved.
          </div>
        )}
      </section>

      {/* Wiki Export */}
      <section
        style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflow: 'hidden',
          marginTop: '1rem',
        }}
      >
        <div style={{ padding: '1.25rem 1.5rem' }}>
          <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: '0.35rem' }}>
            Wiki Export
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', lineHeight: 1.5, marginBottom: '1.25rem' }}>
            Download your entire wiki for backup or use in other tools.
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
            {(['markdown', 'obsidian', 'json', 'kompl'] as const).map((fmt) => (
              <button
                key={fmt}
                onClick={() => void handleExport(fmt)}
                disabled={exportLoading !== null}
                style={{
                  padding: '0.45rem 1rem',
                  fontSize: '0.85rem',
                  opacity: exportLoading !== null ? 0.6 : 1,
                }}
              >
                {exportLoading === fmt
                  ? 'Exporting…'
                  : fmt === 'markdown'
                  ? '↓ Markdown (.zip)'
                  : fmt === 'obsidian'
                  ? '↓ Obsidian (.zip)'
                  : fmt === 'kompl'
                  ? '↓ Kompl Backup'
                  : '↓ JSON'}
              </button>
            ))}
          </div>
        </div>
      </section>

      {/* Import Wiki */}
      <section
        id="import"
        style={{
          border: '1px solid var(--border)',
          borderRadius: 8,
          overflow: 'hidden',
          marginTop: '1rem',
        }}
      >
        <div style={{ padding: '1.25rem 1.5rem' }}>
          <div style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: '0.35rem' }}>
            Import Wiki
          </div>
          <div style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', lineHeight: 1.5, marginBottom: '0.75rem' }}>
            Restore from a .kompl.zip backup. <strong>Only works on an empty wiki</strong> — importing into a wiki that already has data will fail.
          </div>
          <div style={{
            fontSize: '0.8rem',
            color: 'var(--fg-dim)',
            lineHeight: 1.5,
            marginBottom: '1.25rem',
            paddingLeft: '0.75rem',
            borderLeft: '2px solid var(--border)',
          }}>
            Merge import (skip existing pages, dedup by URL/content hash) is not yet implemented.
            To migrate sources from another instance, re-ingest them through onboarding — compilation is deterministic per source so you get the same result.
          </div>
          <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
            <input
              type="file"
              accept=".zip"
              onChange={(e) => { setImportFile(e.target.files?.[0] ?? null); }}
              style={{ fontSize: '0.85rem', color: 'var(--fg)' }}
            />
            <button
              onClick={() => { void handleImport(); }}
              disabled={!importFile || importLoading}
              style={{
                padding: '0.45rem 1rem',
                fontSize: '0.85rem',
                opacity: !importFile || importLoading ? 0.6 : 1,
              }}
            >
              {importLoading ? 'Importing…' : 'Import'}
            </button>
          </div>
          {importError && (
            <div style={{ color: 'var(--danger)', marginTop: '0.75rem', fontSize: '0.85rem' }}>
              {importError}
            </div>
          )}
          {importSuccess && (
            <div style={{ color: 'var(--accent)', marginTop: '0.75rem', fontSize: '0.85rem' }}>
              Imported — redirecting…
            </div>
          )}
        </div>
      </section>
    </main>
  );
}
