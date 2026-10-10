'use client';

/**
 * /settings — one scrollable page, grouped so the decisions that matter most
 * come first: AI model & spend, Connect your AI (MCP), Wiki health,
 * Backup & restore, then Advanced tuning (auto-approve, then the compile
 * quality settings, collapsed).
 *
 * Other pages link to #compile-model, #integrations, #import and
 * #page-upgrade — keep those ids. Layout building blocks live in ./_ui.tsx.
 */

import { useEffect, useState } from 'react';
import { useRouter } from 'next/navigation';
import Link from 'next/link';
import { useToast } from '../../components/Toast';
import WikiLintResults from '../../components/WikiLintResults';
import { normalizeLintResult, type LintResult } from '@/lib/lint-result';
import { toUserMessage } from '@/lib/service-errors';
import {
  Card, NumberField, SavedBar, SettingCard, SettingRow, SettingsGroup, SettingsNav, TogglePill,
  codeStyle, preStyle,
} from './_ui';
import PageUpgradeCard from './PageUpgradeCard';
import {
  DEFAULT_COMPILE_MODEL, LLM_MODELS, LLM_MODEL_INFO, getProviderForModel, isLlmModel,
  type LlmModel, type LlmProvider,
} from '@/lib/llm-models';

const SETTINGS_NAV = [
  { id: 'model', label: 'AI model & spend' },
  { id: 'integrations', label: 'Connect your AI' },
  { id: 'wiki-health', label: 'Wiki health' },
  { id: 'data', label: 'Backup & restore' },
  { id: 'advanced', label: 'Advanced tuning' },
] as const;

async function saveSettingToApi(body: Record<string, unknown>): Promise<boolean> {
  try {
    const res = await fetch('/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return res.ok;
  } catch {
    return false;
  }
}

export default function SettingsPage() {
  const router = useRouter();
  const { toast, showToast } = useToast();

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

  const [entityThreshold, setEntityThreshold] = useState<number | null>(null);
  const [entityThresholdSaving, setEntityThresholdSaving] = useState(false);
  const [entityThresholdSaved, setEntityThresholdSaved] = useState(false);

  const [dossierMaxSources, setDossierMaxSources] = useState<number | null>(null);
  const [dossierMaxSourcesSaving, setDossierMaxSourcesSaving] = useState(false);
  const [dossierMaxSourcesSaved, setDossierMaxSourcesSaved] = useState(false);

  const [dossierMinScore, setDossierMinScore] = useState<number | null>(null);
  const [dossierMinScoreSaving, setDossierMinScoreSaving] = useState(false);
  const [dossierMinScoreSaved, setDossierMinScoreSaved] = useState(false);

  const [dailyCapUsd, setDailyCapUsd] = useState<number | null>(null);
  const [dailyCapSaving, setDailyCapSaving] = useState(false);
  const [dailyCapSaved, setDailyCapSaved] = useState(false);

  const [compileModel, setCompileModelState] = useState<string | null>(null);
  const [compileModelSaving, setCompileModelSaving] = useState(false);
  const [compileModelSaved, setCompileModelSaved] = useState(false);

  // Phase 5/6 multi-provider: presence-only flags from /api/health gate the
  // dropdown options. null = still loading; never throw on a fetch failure
  // (operator on a broken health endpoint should still see Gemini default).
  const [providerKeys, setProviderKeys] = useState<{
    gemini_present: boolean;
    deepseek_present: boolean;
  } | null>(null);

  const [lintEnabled, setLintEnabledState] = useState<boolean | null>(null);
  const [lintSaving, setLintSaving] = useState(false);
  const [lintSaved, setLintSaved] = useState(false);
  const [lintRunning, setLintRunning] = useState(false);

  const [lintLastResult, setLintLastResult] = useState<LintResult | null>(null);
  const [lintLastResultRaw, setLintLastResultRaw] = useState<Record<string, unknown> | null>(null);

  const [mcpCopied, setMcpCopied] = useState(false);

  useEffect(() => {
    void fetch('/api/settings')
      .then((r) => r.json())
      .then((data: {
        auto_approve: boolean;
        related_pages_min_sources: number;
        stale_threshold_days: number;
        lint_enabled: boolean;
        lint_last_result: Record<string, unknown> | null;
        min_source_chars: number;
        min_draft_chars: number;
        entity_promotion_threshold: number;
        dossier_max_sources: number;
        dossier_min_score: number;
        daily_cap_usd: number;
        compile_model: string;
      }) => {
        setAutoApprove(data.auto_approve);
        setRelatedMinSources(data.related_pages_min_sources);
        setStaleThreshold(data.stale_threshold_days);
        setLintEnabledState(data.lint_enabled);
        setLintLastResultRaw(data.lint_last_result);
        setLintLastResult(normalizeLintResult(data.lint_last_result));
        setMinSourceChars(data.min_source_chars);
        setMinDraftChars(data.min_draft_chars);
        setEntityThreshold(data.entity_promotion_threshold);
        setDossierMaxSources(data.dossier_max_sources);
        setDossierMinScore(data.dossier_min_score);
        setDailyCapUsd(data.daily_cap_usd);
        setCompileModelState(data.compile_model);
      });
  }, []);

  // Phase 5/6 multi-provider: fetch the provider-key presence flags so the
  // model dropdowns can disable options whose backend isn't configured.
  // /api/health returns lots of fields; we only read provider_keys here.
  useEffect(() => {
    void fetch('/api/health')
      .then((r) => (r.ok ? r.json() : null))
      .then((data: { provider_keys?: { gemini_present: boolean; deepseek_present: boolean } } | null) => {
        if (data?.provider_keys) {
          setProviderKeys(data.provider_keys);
        }
      })
      .catch(() => {
        // Non-fatal: dropdowns fall back to "all enabled" while
        // providerKeys stays null. The POST validator at /api/settings
        // is the back-stop on actually-invalid selections.
      });
  }, []);

  async function toggle() {
    if (autoApprove === null) return;
    const newVal = !autoApprove;
    setSaving(true);
    setSaved(false);
    const _ok = await saveSettingToApi({ auto_approve: newVal });
    if (!_ok) { setSaving(false); showToast(toUserMessage('settings_save_failed'), 'error'); return; }
    setAutoApprove(newVal);
    setSaving(false);
    setSaved(true);
    setTimeout(() => setSaved(false), 2000);
  }

  async function saveRelatedMinSources() {
    if (relatedMinSources === null) return;
    setRelatedSaving(true);
    setRelatedSaved(false);
    const _ok = await saveSettingToApi({ related_pages_min_sources: relatedMinSources });
    if (!_ok) { setRelatedSaving(false); showToast(toUserMessage("settings_save_failed"), "error"); return; }
    setRelatedSaving(false);
    setRelatedSaved(true);
    setTimeout(() => setRelatedSaved(false), 2000);
  }

  async function saveStaleThreshold() {
    if (staleThreshold === null) return;
    setStaleSaving(true);
    setStaleSaved(false);
    const _ok = await saveSettingToApi({ stale_threshold_days: staleThreshold });
    if (!_ok) { setStaleSaving(false); showToast(toUserMessage("settings_save_failed"), "error"); return; }
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

  async function toggleLint() {
    if (lintEnabled === null || lintSaving) return;
    const newVal = !lintEnabled;
    setLintSaving(true);
    setLintSaved(false);
    const _ok = await saveSettingToApi({ lint_enabled: newVal });
    if (!_ok) { setLintSaving(false); showToast(toUserMessage("settings_save_failed"), "error"); return; }
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
        const data = (await res.json()) as Record<string, unknown>;
        setLintLastResultRaw(data);
        setLintLastResult(normalizeLintResult(data));
      }
    } finally {
      setLintRunning(false);
    }
  }

  async function saveMinSourceChars() {
    if (minSourceChars === null) return;
    setMinSourceCharsSaving(true);
    setMinSourceCharsSaved(false);
    const _ok = await saveSettingToApi({ min_source_chars: minSourceChars });
    if (!_ok) { setMinSourceCharsSaving(false); showToast(toUserMessage("settings_save_failed"), "error"); return; }
    setMinSourceCharsSaving(false);
    setMinSourceCharsSaved(true);
    setTimeout(() => setMinSourceCharsSaved(false), 2000);
  }

  async function saveMinDraftChars() {
    if (minDraftChars === null) return;
    setMinDraftCharsSaving(true);
    setMinDraftCharsSaved(false);
    const _ok = await saveSettingToApi({ min_draft_chars: minDraftChars });
    if (!_ok) { setMinDraftCharsSaving(false); showToast(toUserMessage("settings_save_failed"), "error"); return; }
    setMinDraftCharsSaving(false);
    setMinDraftCharsSaved(true);
    setTimeout(() => setMinDraftCharsSaved(false), 2000);
  }

  async function saveDossierMaxSources() {
    if (dossierMaxSources === null) return;
    setDossierMaxSourcesSaving(true);
    setDossierMaxSourcesSaved(false);
    const _ok = await saveSettingToApi({ dossier_max_sources: dossierMaxSources });
    if (!_ok) { setDossierMaxSourcesSaving(false); showToast(toUserMessage("settings_save_failed"), "error"); return; }
    setDossierMaxSourcesSaving(false);
    setDossierMaxSourcesSaved(true);
    setTimeout(() => setDossierMaxSourcesSaved(false), 2000);
  }

  async function saveDossierMinScore() {
    if (dossierMinScore === null) return;
    setDossierMinScoreSaving(true);
    setDossierMinScoreSaved(false);
    const _ok = await saveSettingToApi({ dossier_min_score: dossierMinScore });
    if (!_ok) { setDossierMinScoreSaving(false); showToast(toUserMessage("settings_save_failed"), "error"); return; }
    setDossierMinScoreSaving(false);
    setDossierMinScoreSaved(true);
    setTimeout(() => setDossierMinScoreSaved(false), 2000);
  }

  async function saveEntityThreshold() {
    if (entityThreshold === null) return;
    setEntityThresholdSaving(true);
    setEntityThresholdSaved(false);
    const _ok = await saveSettingToApi({ entity_promotion_threshold: entityThreshold });
    if (!_ok) { setEntityThresholdSaving(false); showToast(toUserMessage("settings_save_failed"), "error"); return; }
    setEntityThresholdSaving(false);
    setEntityThresholdSaved(true);
    setTimeout(() => setEntityThresholdSaved(false), 2000);
  }

  async function saveDailyCapUsd() {
    if (dailyCapUsd === null) return;
    setDailyCapSaving(true);
    setDailyCapSaved(false);
    const _ok = await saveSettingToApi({ daily_cap_usd: dailyCapUsd });
    if (!_ok) { setDailyCapSaving(false); showToast(toUserMessage("settings_save_failed"), "error"); return; }
    setDailyCapSaving(false);
    setDailyCapSaved(true);
    setTimeout(() => setDailyCapSaved(false), 2000);
  }

  async function saveCompileModel(next: string) {
    setCompileModelSaving(true);
    setCompileModelSaved(false);
    const _ok = await saveSettingToApi({ compile_model: next });
    if (!_ok) { setCompileModelSaving(false); showToast(toUserMessage("settings_save_failed"), "error"); return; }
    setCompileModelState(next);
    setCompileModelSaving(false);
    setCompileModelSaved(true);
    setTimeout(() => setCompileModelSaved(false), 2000);
  }

  const MCP_CONFIG_JSON = `{
  "mcpServers": {
    "kompl-wiki": {
      "type": "stdio",
      "command": "node",
      "args": ["<KOMPL_INSTALL_PATH>/mcp-server/dist/index.js"],
      "env": { "KOMPL_URL": "http://localhost:3000" }
    }
  }
}`;

  const selectedModelInfo =
    compileModel !== null && isLlmModel(compileModel) ? LLM_MODEL_INFO[compileModel] : null;
  const selectedProvider: LlmProvider | null =
    compileModel !== null ? getProviderForModel(compileModel) : null;

  function providerKeyPresent(provider: LlmProvider): boolean {
    // Still loading (or /api/health unreachable): leave every option enabled.
    // The POST validator at /api/settings is the back-stop.
    if (providerKeys === null) return true;
    return provider === 'deepseek' ? providerKeys.deepseek_present : providerKeys.gemini_present;
  }

  const modelGroups: Array<{ label: string; ids: LlmModel[] }> = [
    { label: 'DeepSeek', ids: LLM_MODELS.filter((m) => !LLM_MODEL_INFO[m].legacy && getProviderForModel(m) === 'deepseek') },
    { label: 'Gemini', ids: LLM_MODELS.filter((m) => !LLM_MODEL_INFO[m].legacy && getProviderForModel(m) === 'gemini') },
    { label: 'Legacy (kept for existing installs)', ids: LLM_MODELS.filter((m) => LLM_MODEL_INFO[m].legacy) },
  ];

  const advancedSaved =
    minSourceCharsSaved || minDraftCharsSaved || entityThresholdSaved || dossierMaxSourcesSaved || dossierMinScoreSaved;

  return (
    <>
      {toast}
      <main
        style={{
          maxWidth: 1260,
          margin: '0 auto',
          padding: '3rem 1.5rem 5rem',
          display: 'flex',
          gap: '2.5rem',
          alignItems: 'flex-start',
        }}
      >
        <SettingsNav items={SETTINGS_NAV} />

        <div style={{ flex: 1, minWidth: 0, maxWidth: 1040 }}>
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

          {/* ========== AI model & spend ========== */}
          <SettingsGroup id="model" title="AI model & spend" first>
            <SettingCard
              id="compile-model"
              title="Compile model"
              summary={
                <>
                  Which model the <strong>compile pipeline</strong> uses for every LLM step
                  (extract, resolve, draft, crossref, schema). Compile is where nearly all LLM
                  spend happens, because the pipeline drafts many pages per session.
                </>
              }
              details={
                <>
                  <strong>Long / academic content:</strong> Gemini 2.5 Flash has a documented
                  structured-output truncation pathology on dense inputs above ~50K chars (academic
                  PDFs, surveys, long-form reports). When it triggers, the extract step returns{' '}
                  <code>extract_llm_failed</code> and the source is left without an extraction row.{' '}
                  <strong>DeepSeek V4 Pro handles up to ~200K chars cleanly</strong> — recommended
                  whenever you&apos;re ingesting heavy material. Track this in{' '}
                  <a
                    href="https://github.com/tuirk/Kompl/issues/7"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={{ color: 'var(--accent)', textDecoration: 'underline' }}
                  >
                    issue #7
                  </a>.
                  <br /><br />
                  You can change this any time, but switching mid-session doesn&apos;t retro-apply:
                  in-flight pipelines keep the model they started with until they finish or fail.
                  Cancel + restart to switch.
                </>
              }
              control={
                <select
                  aria-label="Compile model"
                  value={compileModel ?? ''}
                  onChange={(e) => void saveCompileModel(e.target.value)}
                  disabled={compileModel === null || compileModelSaving}
                  style={{
                    padding: '0.45rem 0.6rem',
                    borderRadius: 6,
                    border: '1px solid var(--border)',
                    background: 'var(--bg-card)',
                    color: 'var(--fg)',
                    fontSize: '0.9rem',
                    opacity: compileModel === null ? 0.5 : 1,
                  }}
                >
                  {modelGroups.map((group) => (
                    <optgroup key={group.label} label={group.label}>
                      {group.ids.map((id) => {
                        const provider = getProviderForModel(id);
                        const keyOk = providerKeyPresent(provider);
                        return (
                          <option
                            key={id}
                            value={id}
                            disabled={!keyOk}
                            title={keyOk ? undefined : `Set ${provider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'GEMINI_API_KEY'} in your environment to enable`}
                          >
                            {LLM_MODEL_INFO[id].label}{id === DEFAULT_COMPILE_MODEL ? ' (default)' : ''}
                          </option>
                        );
                      })}
                    </optgroup>
                  ))}
                </select>
              }
              footer={
                <>
                  {selectedModelInfo && (
                    <div style={{ fontSize: '0.83rem', color: 'var(--fg-secondary)', lineHeight: 1.5, marginBottom: '0.75rem' }}>
                      {selectedModelInfo.note}
                    </div>
                  )}
                  {selectedProvider !== null && !providerKeyPresent(selectedProvider) && (
                    <div
                      role="alert"
                      style={{
                        fontSize: '0.83rem',
                        lineHeight: 1.5,
                        color: 'var(--warning)',
                        background: 'rgba(var(--warning-rgb), 0.08)',
                        border: '1px solid rgba(var(--warning-rgb), 0.25)',
                        borderRadius: 6,
                        padding: '0.55rem 0.8rem',
                        marginBottom: '0.75rem',
                      }}
                    >
                      <code style={codeStyle}>{selectedProvider === 'deepseek' ? 'DEEPSEEK_API_KEY' : 'GEMINI_API_KEY'}</code>{' '}
                      is not set, so compiles with this model stop at the health check. Add the key to{' '}
                      <code style={codeStyle}>.env</code> and restart Kompl, or pick a model from the other provider.
                    </div>
                  )}
                  <div style={{ fontSize: '0.82rem', color: 'var(--fg-muted)', lineHeight: 1.5, marginBottom: '0.4rem' }}>
                    Not every Gemini API key has access to every model. To list what your key can use, run:
                  </div>
                  <pre style={preStyle}>{`curl -s -H "x-goog-api-key: $GEMINI_API_KEY" https://generativelanguage.googleapis.com/v1beta/models | jq '.models[].name'`}</pre>
                </>
              }
              saved={compileModelSaved ? 'Saved — applies to new compile sessions.' : null}
            />

            <SettingCard
              title="Daily LLM spend cap"
              badge="Beta"
              summary={
                <>
                  Hard USD ceiling on combined LLM API spend per UTC day across all providers
                  (one shared counter). Resets at midnight UTC. Set to <strong>0</strong> for
                  unlimited (no cap).
                </>
              }
              details={
                <>
                  When exceeded, LLM calls raise a cost-ceiling error and the pipeline marks
                  affected work as retryable.
                  {' '}The tracked number is a Kompl-side estimate from each call&apos;s usage
                  metadata (input + cached + output tokens × the model&apos;s per-million-token
                  price). It&apos;s independent of any provider&apos;s prepaid balance — your
                  DeepSeek/Gemini account ledger is separate.
                  {' '}<strong>Prices may be stale.</strong> Per-million-token rates are hard-coded
                  constants and providers update them periodically; we deliberately ignore
                  promotional discounts (overestimating is the safer side — the cap fires sooner
                  than necessary, never later). Reconcile with the provider&apos;s invoice for
                  ground truth.
                </>
              }
              control={
                <NumberField
                  label="Daily LLM spend cap in US dollars"
                  value={dailyCapUsd}
                  onChange={(raw) => setDailyCapUsd(Math.max(0, parseFloat(raw || '0')))}
                  onBlur={() => void saveDailyCapUsd()}
                  disabled={dailyCapSaving}
                  min={0}
                  step={0.5}
                  prefix="$"
                  unit="/ day"
                  width={88}
                  defaultHint="$5.00"
                />
              }
              saved={dailyCapSaved ? 'Saved — takes effect within 30 seconds.' : null}
            />
          </SettingsGroup>

          {/* ========== Connect your AI ========== */}
          <SettingsGroup
            id="integrations"
            title="Connect your AI"
            intro="Ask questions of your wiki from the AI agent you already use: it searches and reads your pages through Kompl's MCP server."
          >
            <SettingCard
              title="Connect AI agents (MCP)"
              summary={
                <>
                  Expose your wiki to Claude Code, Claude Desktop, Cursor, or any MCP-capable AI agent as a live knowledge source.
                  The server provides four tools:{' '}
                  <code style={codeStyle}>search_wiki</code>,{' '}
                  <code style={codeStyle}>read_page</code>,{' '}
                  <code style={codeStyle}>list_pages</code>,{' '}
                  <code style={codeStyle}>wiki_stats</code>.
                  Kompl must be running for the tools to respond.
                </>
              }
              footer={
                <>
                  <StepLabel first>Step 1 — Build the server (once)</StepLabel>
                  <pre style={preStyle}>cd mcp-server &amp;&amp; npm install &amp;&amp; npm run build</pre>

                  <StepLabel>Step 2 — Register with your AI client</StepLabel>
                  <div style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', lineHeight: 1.5, marginBottom: '0.65rem' }}>
                    <strong style={{ color: 'var(--fg)' }}>Claude Code:</strong> auto-registered via{' '}
                    <code style={codeStyle}>.mcp.json</code>{' '}
                    in the Kompl folder — just restart Claude Code after building.
                  </div>
                  <div style={{ fontSize: '0.85rem', color: 'var(--fg-muted)', lineHeight: 1.5, marginBottom: '0.5rem' }}>
                    <strong style={{ color: 'var(--fg)' }}>Claude Desktop, Cursor, other clients:</strong> paste the block
                    below into the client&apos;s MCP config file. Typical paths:
                  </div>
                  <ul
                    style={{
                      fontSize: '0.8rem',
                      color: 'var(--fg-muted)',
                      lineHeight: 1.7,
                      margin: '0 0 0.85rem',
                      paddingLeft: '1.2rem',
                    }}
                  >
                    <li>
                      macOS:{' '}
                      <code style={codeStyle}>~/Library/Application Support/Claude/claude_desktop_config.json</code>
                    </li>
                    <li>
                      Windows:{' '}
                      <code style={codeStyle}>%APPDATA%\Claude\claude_desktop_config.json</code>
                    </li>
                    <li>
                      Linux:{' '}
                      <code style={codeStyle}>~/.config/Claude/claude_desktop_config.json</code>
                    </li>
                  </ul>

                  <div style={{ position: 'relative' }}>
                    <pre style={{ ...preStyle, paddingRight: '4.5rem', fontSize: '0.82rem' }}>{MCP_CONFIG_JSON}</pre>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(MCP_CONFIG_JSON).then(() => {
                          setMcpCopied(true);
                          setTimeout(() => setMcpCopied(false), 2000);
                        });
                      }}
                      className="btn-outline"
                      style={{
                        position: 'absolute',
                        top: 8,
                        right: 8,
                        padding: '0.25rem 0.6rem',
                        fontSize: '0.75rem',
                      }}
                    >
                      {mcpCopied ? 'Copied' : 'Copy'}
                    </button>
                  </div>

                  <div style={{ fontSize: '0.78rem', color: 'var(--fg-dim)', marginTop: '0.65rem', lineHeight: 1.5 }}>
                    Replace{' '}
                    <code style={codeStyle}>{'<KOMPL_INSTALL_PATH>'}</code>{' '}
                    with the absolute path to your Kompl folder (e.g.{' '}
                    <code style={codeStyle}>C:/Users/you/kompl</code>
                    ).
                  </div>
                </>
              }
            />
          </SettingsGroup>

          {/* ========== Wiki health ========== */}
          <SettingsGroup id="wiki-health" title="Wiki health">
            <PageUpgradeCard />

            <SettingCard
              title="Wiki health checks"
              badge="Beta"
              summary={
                <>
                  Scans for orphan pages, stale summaries, dead provenance links,
                  entity names with no wiki page (3+ sources mention them), and
                  contradictions between pages. Runs when you click Run Now, or
                  automatically at startup if lint hasn&apos;t run in the last 36 hours
                  (when lint is enabled).
                </>
              }
              control={
                <div style={{ display: 'flex', gap: '0.5rem', alignItems: 'flex-start' }}>
                  <button
                    type="button"
                    onClick={() => void runLintNow()}
                    disabled={lintRunning}
                    className="btn-outline"
                    style={{ padding: '0.45rem 1rem', borderRadius: 20, fontSize: '0.85rem' }}
                  >
                    {lintRunning ? 'Running…' : 'Run Now'}
                  </button>
                  <TogglePill
                    label="Scheduled wiki health checks"
                    value={lintEnabled}
                    onClick={() => void toggleLint()}
                    disabled={lintSaving}
                    defaultHint="ON"
                  />
                </div>
              }
              saved={lintSaved ? 'Saved.' : null}
            >
              {(lintLastResult || lintRunning) && (
                <div style={{ padding: '0 1.5rem 1.25rem', borderTop: '1px solid var(--border)' }}>
                  <WikiLintResults result={lintLastResult} raw={lintLastResultRaw} running={lintRunning} />
                </div>
              )}
            </SettingCard>

            <SettingCard
              title="Stale source alerts"
              summary={
                <>
                  Show a reminder on the dashboard when sources haven&apos;t been updated in a while.
                  Set to <strong>0</strong> to disable.
                </>
              }
              control={
                <NumberField
                  label="Stale source alert threshold in days"
                  value={staleThreshold}
                  onChange={(raw) => setStaleThreshold(Math.max(0, parseInt(raw || '0', 10)))}
                  onBlur={() => void saveStaleThreshold()}
                  disabled={staleSaving}
                  min={0}
                  step={1}
                  unit="days"
                  width={72}
                  defaultHint="90 days"
                />
              }
              saved={staleSaved ? 'Saved.' : null}
            />

            <SettingCard
              title="Related pages threshold"
              summary={
                <>
                  Show a &quot;You might also read&quot; panel on wiki pages once at least this many sources
                  have been ingested. Uses embedding similarity — zero LLM cost.
                  Set to <strong>0</strong> to always show.
                </>
              }
              control={
                <NumberField
                  label="Related pages threshold in sources"
                  value={relatedMinSources}
                  onChange={(raw) => setRelatedMinSources(Math.max(0, parseInt(raw || '0', 10)))}
                  onBlur={() => void saveRelatedMinSources()}
                  disabled={relatedSaving}
                  min={0}
                  step={1}
                  unit="sources"
                  width={72}
                  defaultHint="10 sources"
                />
              }
              saved={relatedSaved ? 'Saved.' : null}
            />
          </SettingsGroup>

          {/* ========== Backup & restore ========== */}
          <SettingsGroup id="data" title="Backup & restore">
            <SettingCard
              title="Wiki export"
              summary={
                <>
                  Download your entire wiki for backup or use in other tools.{' '}
                  <strong>Kompl Backup</strong> (.kompl.zip) is the format Import can restore.
                </>
              }
              footer={
                <div style={{ display: 'flex', gap: '0.75rem', flexWrap: 'wrap' }}>
                  {(['markdown', 'obsidian', 'json', 'kompl'] as const).map((fmt) => (
                    <button
                      type="button"
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
              }
            />

            <SettingCard
              id="import"
              title="Import wiki"
              summary={
                <>
                  Restore from a .kompl.zip backup. <strong>Only works on an empty wiki</strong> — importing
                  into a wiki that already has data will fail.
                </>
              }
              details={
                <>
                  Merge import (skip existing pages, dedup by URL/content hash) is not yet implemented.
                  To migrate sources from another instance, re-ingest them through onboarding — compilation
                  is deterministic per source so you get the same result.
                </>
              }
              footer={
                <>
                  <div style={{ display: 'flex', gap: '0.75rem', alignItems: 'center', flexWrap: 'wrap' }}>
                    <input
                      type="file"
                      accept=".zip"
                      aria-label="Backup file to import"
                      onChange={(e) => { setImportFile(e.target.files?.[0] ?? null); }}
                      style={{ fontSize: '0.85rem', color: 'var(--fg)' }}
                    />
                    <button
                      type="button"
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
                    <div
                      style={{
                        marginTop: '0.75rem',
                        padding: '0.6rem 0.9rem',
                        background: 'var(--success-bg)',
                        border: '1px solid var(--success-border)',
                        borderRadius: 6,
                        color: 'var(--success)',
                        fontSize: '0.85rem',
                      }}
                    >
                      Imported — redirecting…
                    </div>
                  )}
                </>
              }
            />
          </SettingsGroup>

          {/* ========== Advanced tuning ========== */}
          <SettingsGroup
            id="advanced"
            title="Advanced tuning"
            intro="Defaults work for most wikis. Change these only when you want to review changes before they reach the wiki, when drafts look thin or noisy, or when a compile costs more than you expect."
          >
            <SettingCard
              id="auto-approve"
              title="Auto-approve wiki changes"
              summary={
                <>
                  When enabled, compiled pages are committed immediately to the wiki.
                  When disabled, changes appear as drafts on your dashboard for review before publishing.
                </>
              }
              control={
                <TogglePill
                  label="Auto-approve wiki changes"
                  value={autoApprove}
                  onClick={() => void toggle()}
                  disabled={saving}
                  defaultHint="ON"
                />
              }
              saved={saved ? 'Saved.' : null}
            />

            <Card>
              <details>
                <summary
                  style={{
                    cursor: 'pointer',
                    padding: '1rem 1.5rem',
                    fontWeight: 600,
                    fontSize: '0.95rem',
                  }}
                >
                  Compilation quality <span style={{ fontWeight: 400, color: 'var(--fg-dim)', fontSize: '0.85rem' }}>· 5 settings</span>
                </summary>
                <div style={{ padding: '0.25rem 1.5rem 1.25rem' }}>
                  <SettingRow
                    first
                    title="Minimum source length for wiki page"
                    summary={
                      <>
                        Sources shorter than this get extracted but won&apos;t have their own summary page.
                        Tweets, error pages, and short scrapes are filtered here. Set to <strong>0</strong> to disable.
                      </>
                    }
                    control={
                      <NumberField
                        label="Minimum source length in characters"
                        value={minSourceChars}
                        onChange={(raw) => setMinSourceChars(Math.max(0, parseInt(raw || '0', 10)))}
                        onBlur={() => void saveMinSourceChars()}
                        disabled={minSourceCharsSaving}
                        min={0}
                        step={50}
                        unit="chars"
                        defaultHint="500"
                      />
                    }
                  />
                  <SettingRow
                    title="Minimum draft length to commit"
                    summary={
                      <>
                        If the AI produces a draft shorter than this, it won&apos;t be committed.
                        The draft is logged so you can review it. Set to <strong>0</strong> to disable.
                      </>
                    }
                    control={
                      <NumberField
                        label="Minimum draft length in characters"
                        value={minDraftChars}
                        onChange={(raw) => setMinDraftChars(Math.max(0, parseInt(raw || '0', 10)))}
                        onBlur={() => void saveMinDraftChars()}
                        disabled={minDraftCharsSaving}
                        min={0}
                        step={50}
                        unit="chars"
                        defaultHint="800"
                      />
                    }
                  />
                  <SettingRow
                    title="Entity promotion threshold"
                    summary={
                      <>
                        Minimum distinct sources that must mention an entity (or concept)
                        before it gets its own page. Counted across the whole wiki — every
                        new source can tip older mentions over the line. Default <strong>2</strong>.
                      </>
                    }
                    control={
                      <NumberField
                        label="Entity promotion threshold in sources"
                        value={entityThreshold}
                        onChange={(raw) => setEntityThreshold(Math.max(1, parseInt(raw || '1', 10)))}
                        onBlur={() => void saveEntityThreshold()}
                        disabled={entityThresholdSaving}
                        min={1}
                        step={1}
                        unit="sources"
                        defaultHint="2"
                      />
                    }
                  />
                  <SettingRow
                    title="Max sources per page"
                    summary={
                      <>
                        When a page has many contributing sources, the drafter only sees
                        the top N by TF-IDF relevance to the page title. Higher = more
                        context, slower drafts, higher cost. Default <strong>12</strong>.
                      </>
                    }
                    control={
                      <NumberField
                        label="Maximum sources per page"
                        value={dossierMaxSources}
                        onChange={(raw) => setDossierMaxSources(Math.max(1, parseInt(raw || '1', 10)))}
                        onBlur={() => void saveDossierMaxSources()}
                        disabled={dossierMaxSourcesSaving}
                        min={1}
                        step={1}
                        unit="sources"
                        defaultHint="12"
                      />
                    }
                  />
                  <SettingRow
                    title="Minimum relevance score"
                    summary={
                      <>
                        Sources scoring below this TF-IDF cosine similarity against the
                        page title are dropped from the per-page draft context.
                        <strong> 0</strong> = include anything that mentions the topic;
                        <strong> 0.1</strong> = exclude trivially-matched sources. Tune
                        after observing real drafts. Default <strong>0.05</strong>.
                      </>
                    }
                    control={
                      <NumberField
                        label="Minimum relevance score"
                        value={dossierMinScore}
                        onChange={(raw) => {
                          const n = parseFloat(raw || '0');
                          setDossierMinScore(Number.isFinite(n) && n >= 0 ? n : 0);
                        }}
                        onBlur={() => void saveDossierMinScore()}
                        disabled={dossierMinScoreSaving}
                        min={0}
                        step={0.01}
                        unit="score"
                        defaultHint="0.05"
                      />
                    }
                  />
                </div>
              </details>
              {advancedSaved && <SavedBar>Saved.</SavedBar>}
            </Card>
          </SettingsGroup>
        </div>
      </main>
    </>
  );
}

function StepLabel({ children, first = false }: { children: React.ReactNode; first?: boolean }) {
  return (
    <div
      style={{
        fontFamily: 'var(--font-mono)',
        fontSize: 10,
        textTransform: 'uppercase',
        letterSpacing: '0.8px',
        color: 'var(--fg-dim)',
        marginBottom: '0.4rem',
        marginTop: first ? 0 : '1.1rem',
      }}
    >
      {children}
    </div>
  );
}
