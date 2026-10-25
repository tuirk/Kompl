// Browser events for the current visit: console errors and warnings, uncaught
// exceptions, failed requests, 4xx/5xx responses and slow API calls. Each visit
// drains the buffer and turns it into findings (visit.mjs).
import { SLOW_API_MS, isExpectedResponse } from "./config.mjs";
import { MACHINE_NET } from "./net.mjs";

/** React's hydration errors, in development wording and as production error codes. */
export const HYDRATION_RE = /hydrat|did not match|server rendered HTML|Text content does not match|Minified React error #(418|419|421|422|423|425)\b/i;

export function attachCollectors(page, base) {
  let events = [];
  const origin = new URL(base).origin;
  const push = (e) => events.push({ at: Date.now(), pageUrl: page.url(), ...e });

  page.on("console", (msg) => {
    const level = msg.type();
    if (level !== "error" && level !== "warning" && level !== "assert") return;
    const text = msg.text();
    // Covered by the response and requestfailed events, which know what was expected or blocked.
    if (/^Failed to load resource/.test(text)) return;
    if (/ERR_BLOCKED_BY_CLIENT/.test(text)) return;
    const loc = msg.location();
    push({ type: "console", level, text, where: loc?.url ? `${loc.url}:${loc.lineNumber}` : "" });
  });
  page.on("pageerror", (err) => push({ type: "pageerror", text: err.message, stack: (err.stack ?? "").split("\n").slice(0, 6).join("\n") }));
  page.on("requestfailed", (req) => {
    const errorText = req.failure()?.errorText ?? "";
    if (/ERR_BLOCKED_BY_CLIENT/.test(errorText)) return; // our own guard; logged there
    // Aborted on purpose: a navigation away, an AbortController, a prefetch dropped.
    if (/ERR_ABORTED|NS_BINDING_ABORTED/.test(errorText)) return;
    if (MACHINE_NET.test(errorText)) return; // the machine slept or its network changed
    push({ type: "requestfailed", url: req.url(), method: req.method(), resourceType: req.resourceType(), errorText });
  });
  page.on("response", (res) => {
    const status = res.status();
    const req = res.request();
    const url = res.url();
    if (status >= 400 && !isExpectedResponse(url, status)) {
      push({ type: "http", url, status, method: req.method(), resourceType: req.resourceType(), sameOrigin: url.startsWith(origin) });
    }
    if (url.startsWith(`${origin}/api/`)) {
      const t = req.timing();
      const ms = t.responseEnd > 0 ? t.responseEnd : t.responseStart;
      if (ms > SLOW_API_MS) push({ type: "slow-api", url, ms: Math.round(ms) });
    }
  });

  return {
    drain() { const e = events; events = []; return e; },
    reset() { events = []; },
  };
}

/** Turns one visit's events into findings (without screenshots; the caller adds them). */
export function eventFindings(events, where) {
  const out = [];
  for (const e of events) {
    const at = { ...where, url: e.pageUrl ?? where.url };
    if (e.type === "pageerror") {
      out.push({ ...at, severity: "high", kind: "pageerror", title: `Uncaught exception: ${e.text.slice(0, 160)}`, detail: e.stack });
    } else if (e.type === "console" && HYDRATION_RE.test(e.text)) {
      out.push({ ...at, severity: "high", kind: "hydration", title: `Hydration error: ${e.text.slice(0, 160)}`, detail: `${e.text}\n${e.where}` });
    } else if (e.type === "console") {
      out.push({ ...at, severity: e.level === "warning" ? "low" : "medium", kind: `console-${e.level}`,
        title: `Console ${e.level}: ${e.text.slice(0, 160)}`, detail: `${e.text}\n${e.where}` });
    } else if (e.type === "requestfailed") {
      // Refused or reset: the server was not listening (the stack restarting), not a broken screen.
      const down = /ERR_CONNECTION_(REFUSED|RESET)/.test(e.errorText);
      out.push({ ...at, severity: down ? "info" : "medium", kind: "request-failed", title: `Request failed (${e.errorText}): ${e.method} ${shortUrl(e.url)}`,
        groupBy: `${e.errorText} ${e.method} ${shortUrl(e.url)}`, detail: `${e.resourceType} ${e.url}` });
    } else if (e.type === "http") {
      const doc = e.resourceType === "document";
      const sev = e.status >= 500 ? (doc ? "critical" : "high") : doc ? "high" : "medium";
      out.push({ ...at, severity: sev, kind: doc ? "http-document" : "http-error",
        title: `HTTP ${e.status} on ${e.method} ${shortUrl(e.url)}`, detail: `${e.resourceType} ${e.url}` });
    } else if (e.type === "slow-api") {
      out.push({ ...at, severity: "low", kind: "slow-api", title: `Slow API response: ${shortUrl(e.url)} took ${e.ms} ms`,
        groupBy: `slow ${shortUrl(e.url)}`, detail: e.url });
    }
  }
  return out;
}

/** Path and query of a URL, with Next.js' _rsc cache-buster dropped. */
export function shortUrl(u) {
  try {
    const x = new URL(u);
    x.searchParams.delete("_rsc");
    const q = x.searchParams.toString();
    return `${x.pathname}${q ? `?${q}` : ""}`.slice(0, 140);
  } catch { return String(u).slice(0, 140); }
}
