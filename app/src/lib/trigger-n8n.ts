/**
 * Shared helper to trigger the n8n session-compile webhook.
 *
 * Both /api/onboarding/confirm and /api/compile/retry call into n8n. Before
 * this helper existed, confirm used fire-and-forget (silent-swallowed errors
 * left compile_progress rows stuck at 'queued' forever) while retry had its
 * own inline probe+surface pattern. This consolidates both.
 *
 * Returns a discriminated union so callers can map failure modes to different
 * HTTP status codes (confirm → 503, retry → 502/504) without try/catch
 * ceremony and without losing the specific failure reason.
 */

export type TriggerResult =
  | { ok: true }
  | {
      ok: false;
      reason: 'n8n_unreachable' | 'n8n_timeout' | 'n8n_webhook_failed';
      upstreamStatus?: number;
    };

const N8N_WEBHOOK_URL = process.env.N8N_WEBHOOK_URL ?? 'http://n8n:5678/webhook';
const ATTEMPTS = 2;
const DELAY_MS = 1000;
const TIMEOUT_MS = 10_000;

async function postOnce(sessionId: string): Promise<TriggerResult> {
  try {
    const res = await fetch(`${N8N_WEBHOOK_URL}/session-compile`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ session_id: sessionId }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (res.ok) return { ok: true };
    return { ok: false, reason: 'n8n_webhook_failed', upstreamStatus: res.status };
  } catch (err) {
    const isTimeout = err instanceof Error && err.name === 'TimeoutError';
    return { ok: false, reason: isTimeout ? 'n8n_timeout' : 'n8n_unreachable' };
  }
}

export async function triggerSessionCompile(sessionId: string): Promise<TriggerResult> {
  for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
    const result = await postOnce(sessionId);
    if (result.ok) return result;
    if (attempt < ATTEMPTS) await new Promise((r) => setTimeout(r, DELAY_MS));
    else return result;
  }
  return { ok: false, reason: 'n8n_unreachable' };
}
