/**
 * Error code → user-facing message registry.
 *
 * When API routes hit a downstream service failure (n8n, nlp-service, file
 * flush, polling), they return a stable `error` code string. UI code uses
 * `toUserMessage(code)` to render the human-readable form. This keeps the
 * error-text policy in one place instead of scattered inline switches.
 */

export const SERVICE_ERROR_MESSAGES = {
  n8n_unreachable:      'Background worker (n8n) is unreachable. Check Docker and try again.',
  n8n_timeout:          'Background worker (n8n) timed out. Check Docker and try again.',
  n8n_webhook_failed:   'Background worker (n8n) rejected the request. Restart Docker and try again.',
  n8n_not_ready:        'Background worker (n8n) is still starting up. Try again in a moment.',
  nlp_unreachable:      'NLP service is down. Restart Docker and try again.',
  nlp_convert_failed:   'NLP service could not convert the source. Try again or use a different URL/file.',
  file_flush_pending:   'Page saved, disk flush pending. Will retry on next startup.',
  backend_lost:         'Lost connection to backend — retrying…',
  never_started:        'Compile did not start — background worker was unreachable. Click Retry.',
  ingest_failed:        'Could not ingest this source. See saved-links page for details.',
  commit_failed:        'Could not save your changes. Try again.',
  chat_synthesis_failed:'Chat could not generate an answer. Try again.',
  file_upload_failed:   'File upload failed. Try again.',
  no_items_staged:      'No sources to compile. Add at least one, or uncheck fewer items.',
  stage_insert_failed:  'Could not save your selection. Try again.',
} as const;

export type ServiceErrorCode = keyof typeof SERVICE_ERROR_MESSAGES;

export function toUserMessage(code: string, fallback = 'Something went wrong'): string {
  return SERVICE_ERROR_MESSAGES[code as ServiceErrorCode] ?? fallback;
}
