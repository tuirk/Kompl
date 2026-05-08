import { Agent } from 'undici';

// Node's built-in fetch (undici) defaults headersTimeout=300_000 ms — shorter
// than the long AbortSignals we set on LLM-bound and dense-PDF NLP calls
// (extract LLM, draft, crossref, NER on academic PDFs, etc.), so
// HeadersTimeoutError fires before our AbortSignal ever kicks in. This shared
// Agent has 16-min headersTimeout/bodyTimeout — covers the longest single
// request (15-min draft) plus buffer.
//
// Apply via `dispatcher: LONG_HTTP_AGENT` to any fetch whose AbortSignal
// exceeds 300_000 ms. Calls under 300_000 ms can stay on the default Agent
// to preserve fail-fast behavior on short-path routes (resolve/match/plan/
// commit are on the default Agent intentionally).
//
// Ref: https://nodejs.org/api/globals.html#custom-dispatcher
//
// undici pinned to ^7 in package.json. undici 8 reworked dispatcher
// composition to require an `onRequestStart` interceptor method shape that
// this Agent does not expose when passed via `dispatcher:` to Node's
// built-in fetch — fails with `InvalidArgumentError: invalid onRequestStart
// method` at draft/crossref time. Dependabot will re-propose undici 8: do
// not merge that bump until callers are migrated to undici-8-compatible
// dispatcher API (`undici.request()` direct, or `setGlobalDispatcher()` on
// a v8 Agent).
export const LONG_HTTP_AGENT = new Agent({
  headersTimeout: 16 * 60_000,
  bodyTimeout: 16 * 60_000,
  connectTimeout: 10_000,
  keepAliveTimeout: 60_000,
});
