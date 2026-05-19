/**
 * Error code → structured remediation registry.
 *
 * When API routes hit a downstream service failure (n8n, nlp-service, file
 * flush, polling), they return a stable `error` code string. UI code uses
 * `toUserMessage(code)` to render the human-readable form. This keeps the
 * error-text policy in one place instead of scattered inline switches.
 *
 * Each entry carries three layers of detail:
 *   - title: one-line user-facing message (what every existing caller already
 *            shows via toUserMessage). Preserved as a string so the 23 current
 *            call sites keep working unchanged.
 *   - body:  one-line explanation of what breaks downstream when the failure
 *            fires. Consumed by the pre-stage health table.
 *   - fix:   one-line operator action (env var, command). Consumed by the
 *            pre-stage health table as a selectable code snippet.
 *
 * Adding a new code: pick a stable snake_case string, add the entry below,
 * add a test row in `__tests__/service-errors.test.ts`.
 */

export interface Remediation {
  title: string;
  body: string;
  fix: string;
}

export const SERVICE_ERROR_MESSAGES = {
  n8n_unreachable: {
    title: 'Background worker (n8n) is unreachable. Check Docker and try again.',
    body: 'n8n orchestrates the compile pipeline. Without it, /api/onboarding/finalize cannot dispatch the session-compile workflow.',
    fix: 'docker compose up n8n  (or restart the whole stack: `docker compose restart`)',
  },
  n8n_timeout: {
    title: 'Background worker (n8n) timed out. Check Docker and try again.',
    body: 'n8n accepted the request but did not acknowledge within the timeout window. Usually a startup race or a stuck workflow.',
    fix: 'docker compose restart n8n  (then retry the action)',
  },
  n8n_webhook_failed: {
    title: 'Background worker (n8n) rejected the request. Restart Docker and try again.',
    body: 'The session-compile webhook returned non-2xx. Workflow JSON may have failed to import or the webhook path was renamed.',
    fix: 'docker compose restart n8n  (then verify the workflow is active in the n8n UI)',
  },
  n8n_not_ready: {
    title: 'Background worker (n8n) is still starting up. Try again in a moment.',
    body: 'n8n is in its boot phase and has not yet registered the webhook endpoint.',
    fix: 'Wait ~30 seconds, then retry. If it persists, check `docker compose logs n8n`.',
  },
  nlp_unreachable: {
    title: 'NLP service is down. Restart Docker and try again.',
    body: 'The NLP service handles extraction, embeddings, and source conversion. Without it, no compile step past stage-intent can run.',
    fix: 'docker compose up nlp-service  (verify with `curl http://localhost:8000/health`)',
  },
  nlp_convert_failed: {
    title: 'NLP service could not convert the source. Try again or use a different URL/file.',
    body: 'Conversion failed deterministically — bad URL, unsupported MIME type, or a malformed file.',
    fix: 'Inspect the source. For URLs, try the canonical form. For files, re-export from the original tool.',
  },
  nlp_convert_timeout: {
    title: 'NLP service took too long to convert this source. Try again or use a different URL/file.',
    body: 'Conversion exceeded the per-source timeout. Common for very large PDFs or slow upstream sites.',
    fix: 'Retry the same source. If it keeps timing out, split the input into smaller pieces.',
  },
  file_flush_pending: {
    title: 'Page saved, disk flush pending. Will retry on next startup.',
    body: 'The page was committed to the database via the outbox pattern but the markdown file did not reach disk yet. The boot reconciler will re-flush on next startup.',
    fix: 'No action required. If the message persists across restarts, check `docker compose logs app`.',
  },
  backend_lost: {
    title: 'Lost connection to backend — retrying…',
    body: 'The browser cannot reach the Next.js server. App container may be restarting or the network bridge dropped.',
    fix: 'Verify `docker compose ps` shows app as healthy. If not, `docker compose up app`.',
  },
  never_started: {
    title: 'Compile did not start — background worker was unreachable. Click Retry.',
    body: 'The compile session was created but n8n never received the webhook. Reconciler will clean up after 5 minutes if Retry is not clicked.',
    fix: 'Click Retry. If it fails again, restart n8n: `docker compose restart n8n`.',
  },
  ingest_failed: {
    title: 'Could not ingest this source. See saved-links page for details.',
    body: 'A specific source failed at ingest time (URL fetch error, file parse error, blocklist hit). The compile continued with the remaining sources.',
    fix: 'Visit the Saved Links page to see which sources failed and why.',
  },
  commit_failed: {
    title: 'Could not save your changes. Try again.',
    body: 'Page commit failed at the database or storage layer. Outbox phase 1 succeeded but phase 3a (write-page) errored.',
    fix: 'Retry the action. If it persists, check `docker compose logs app`.',
  },
  chat_synthesis_failed: {
    title: 'Chat could not generate an answer. Try again.',
    body: 'The LLM call inside the chat synthesis step failed — provider error, rate limit, or token cap.',
    fix: 'Retry. If repeated, check the Settings → Daily-cap section and the provider dashboard for rate-limit status.',
  },
  file_upload_failed: {
    title: 'File upload failed. Try again.',
    body: 'The browser-to-server upload errored before the file reached staging.',
    fix: 'Retry. Confirm the file is under any size limits and a supported format.',
  },
  no_items_staged: {
    title: 'No sources to compile. Add at least one, or uncheck fewer items.',
    body: 'Finalize was called against an empty staging set.',
    fix: 'Go back and add at least one source, or recheck items you may have toggled off.',
  },
  stage_insert_failed: {
    title: 'Could not save your selection. Try again.',
    body: 'The staging-row insert failed at the database layer.',
    fix: 'Retry. If it persists, check `docker compose logs app` for SQLite errors.',
  },
  session_in_progress: {
    title: 'Another compile session is already running. Wait for it to finish or cancel it from the progress page.',
    body: 'Only one compile session per database is supported at a time.',
    fix: 'Visit the Progress page, wait for completion, or cancel the active session.',
  },
} as const;

export type ServiceErrorCode = keyof typeof SERVICE_ERROR_MESSAGES;

/**
 * Back-compat shim — returns the `title` string for the given code, or the
 * fallback when the code is unknown. Every existing caller treats the return
 * as a string; this contract is preserved.
 */
export function toUserMessage(code: string, fallback = 'Something went wrong'): string {
  const entry = SERVICE_ERROR_MESSAGES[code as ServiceErrorCode];
  return entry?.title ?? fallback;
}

/**
 * Structured-remediation accessor. Returns the full `{ title, body, fix }`
 * object for known codes, or undefined for unknown ones. Consumed by the
 * pre-stage health table.
 */
export function getRemediation(code: string): Remediation | undefined {
  return SERVICE_ERROR_MESSAGES[code as ServiceErrorCode];
}
