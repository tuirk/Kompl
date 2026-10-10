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
}

export type QueryValue = string | number | boolean | undefined;

export type ApiResult<T> =
  | { ok: true; data: T }
  | { ok: false; status: number | null; message: string };

const DEFAULT_TIMEOUT_MS = 20_000;

export class KomplClient {
  readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(options: KomplClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  /** GET an app route and parse its JSON body. */
  async get<T>(path: string, params: Record<string, QueryValue> = {}): Promise<ApiResult<T>> {
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
      res = await this.fetchImpl(url, { signal: AbortSignal.timeout(this.timeoutMs) });
    } catch (err) {
      return {
        ok: false,
        status: null,
        message: isTimeout(err)
          ? this.timeoutMessage(path)
          : `Kompl isn't reachable at ${this.baseUrl}. Is it running? Start it with \`kompl start\`.`,
      };
    }

    if (!res.ok) {
      return { ok: false, status: res.status, message: await errorDetail(res) };
    }
    try {
      return { ok: true, data: (await res.json()) as T };
    } catch (err) {
      return {
        ok: false,
        status: res.status,
        message: isTimeout(err)
          ? this.timeoutMessage(path)
          : `Kompl sent a response to ${path} that isn't valid JSON.`,
      };
    }
  }

  private timeoutMessage(path: string): string {
    return `Kompl took longer than ${Math.round(this.timeoutMs / 1000)}s to answer ${path}. Try again in a moment.`;
  }
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
