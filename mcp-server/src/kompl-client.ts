/**
 * HTTP access to the Kompl app. The MCP server never touches the database or
 * the NLP service directly: every tool goes through the app's /api routes.
 *
 * Failures come back as values (never thrown) so each tool can turn them into
 * an MCP error result the agent can act on.
 */

export interface KomplClientOptions {
  /** Base URL of the Kompl app, e.g. http://localhost:3000 */
  baseUrl: string;
  /** Injected for tests; defaults to the global fetch. */
  fetchImpl?: typeof fetch;
  /** Per-request timeout. */
  timeoutMs?: number;
  /** Timeout for requests that start work and may wait on n8n (add_source). */
  slowTimeoutMs?: number;
}

export type QueryValue = string | number | boolean | undefined;

export type ApiResult<T> =
  | { ok: true; data: T }
  /** timedOut: no full answer in time, whether or not the headers had arrived. */
  | { ok: false; status: number | null; message: string; timedOut?: boolean };

const DEFAULT_TIMEOUT_MS = 20_000;
/** Longer than the app's own wait for n8n (two 10 s attempts). */
const DEFAULT_SLOW_TIMEOUT_MS = 45_000;

export class KomplClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly slowTimeoutMs: number;

  constructor(options: KomplClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.slowTimeoutMs = options.slowTimeoutMs ?? DEFAULT_SLOW_TIMEOUT_MS;
  }

  /** GET an app route and parse its JSON body. */
  get<T>(path: string, params: Record<string, QueryValue> = {}): Promise<ApiResult<T>> {
    return this.request<T>(path, params);
  }

  /** POST a JSON body to an app route and parse its JSON answer. */
  post<T>(path: string, body: unknown, options: { slow?: boolean } = {}): Promise<ApiResult<T>> {
    return this.request<T>(
      path,
      {},
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      options.slow ? this.slowTimeoutMs : this.timeoutMs
    );
  }

  private async request<T>(
    path: string,
    params: Record<string, QueryValue>,
    init: RequestInit = {},
    timeoutMs = this.timeoutMs
  ): Promise<ApiResult<T>> {
    let url: URL;
    try {
      url = new URL(this.baseUrl + path);
    } catch {
      return {
        ok: false,
        status: null,
        message: `KOMPL_URL "${this.baseUrl}" isn't a valid URL. Set it to the app address, e.g. http://localhost:3000.`,
      };
    }
    for (const [key, value] of Object.entries(params)) {
      if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
    }

    let res: Response;
    try {
      res = await this.fetchImpl(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
    } catch (err) {
      if (isTimeout(err)) return { ok: false, status: null, message: timeoutMessage(path, timeoutMs), timedOut: true };
      return {
        ok: false,
        status: null,
        message: `Kompl isn't reachable at ${this.baseUrl}. Is it running? Start it with \`kompl start\`.`,
      };
    }

    if (!res.ok) {
      return { ok: false, status: res.status, message: await errorDetail(res) };
    }
    try {
      return { ok: true, data: (await res.json()) as T };
    } catch (err) {
      // The headers came but the body didn't finish: still a timeout.
      if (isTimeout(err)) return { ok: false, status: res.status, message: timeoutMessage(path, timeoutMs), timedOut: true };
      return { ok: false, status: res.status, message: `Kompl sent a response to ${path} that isn't valid JSON.` };
    }
  }
}

function timeoutMessage(path: string, timeoutMs: number): string {
  return `Kompl took longer than ${Math.round(timeoutMs / 1000)}s to answer ${path}. Try again in a moment.`;
}

/** AbortSignal.timeout rejects with a TimeoutError DOMException (AbortError on some runtimes). */
function isTimeout(err: unknown): boolean {
  return err instanceof Error && (err.name === 'TimeoutError' || err.name === 'AbortError');
}

/** The app's error routes answer `{error, message?}`; fall back to the status line. */
async function errorDetail(res: Response): Promise<string> {
  try {
    const body = (await res.json()) as { error?: unknown; message?: unknown };
    if (typeof body.message === 'string' && body.message) return body.message;
    if (typeof body.error === 'string' && body.error) return body.error;
  } catch {
    // Not JSON — use the status below.
  }
  return `HTTP ${res.status}`;
}
