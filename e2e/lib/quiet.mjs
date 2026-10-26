// "Quiet": the page has no request in flight and its DOM has not changed for
// QUIET_MS, then two animation frames so what is shown is painted. The film kit
// waits the same way before each shot (network idle plus a settle), but here
// the wait is measured instead of fixed, so a page that never settles is
// reported rather than shot mid-change.
import { LONG_REQUEST_MS, QUIET_MS, QUIET_TIMEOUT_MS } from "./config.mjs";

/** Init script: records the time of the last DOM change in window.__e2eLastChange. */
export const QUIET_INIT = `(() => {
  if (window.__e2eQuiet) return;
  window.__e2eQuiet = true;
  window.__e2eLastChange = performance.now();
  const start = () => {
    new MutationObserver(() => { window.__e2eLastChange = performance.now(); })
      .observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
  };
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start); else start();
})();`;

/** Tracks requests in flight on one page (streams and long polls aside). */
export function trackRequests(page) {
  const open = new Map();
  const add = (r) => {
    const t = r.resourceType();
    if (t === "eventsource" || t === "websocket") return;
    open.set(r, Date.now());
  };
  const done = (r) => open.delete(r);
  page.on("request", add);
  page.on("requestfinished", done);
  page.on("requestfailed", done);
  return {
    /** Requests still open, not counting ones older than LONG_REQUEST_MS. */
    inflight() {
      const now = Date.now();
      let n = 0;
      for (const [, t] of open) if (now - t < LONG_REQUEST_MS) n++;
      return n;
    },
    reset() { open.clear(); },
  };
}

/**
 * Waits for quiet. Returns { quiet, ms, why } where why says what kept it busy
 * when the timeout ran out ("network" or "dom").
 */
export async function waitForQuiet(page, tracker, { quietMs = QUIET_MS, timeout = QUIET_TIMEOUT_MS } = {}) {
  const t0 = Date.now();
  let netQuietSince = null;
  let why = "network";
  await page.evaluate(QUIET_INIT).catch(() => {});
  while (Date.now() - t0 < timeout) {
    const busy = tracker.inflight() > 0;
    if (busy) netQuietSince = null;
    else netQuietSince ??= Date.now();
    if (netQuietSince && Date.now() - netQuietSince >= quietMs) {
      const sinceChange = await page.evaluate(() => performance.now() - (window.__e2eLastChange ?? 0)).catch(() => quietMs);
      if (sinceChange >= quietMs) {
        await page.evaluate(() => document.fonts?.ready).catch(() => {});
        await paint(page);
        return { quiet: true, ms: Date.now() - t0 };
      }
      why = "dom";
    } else why = "network";
    await page.waitForTimeout(100);
  }
  await paint(page);
  return { quiet: false, ms: Date.now() - t0, why };
}

/** Two animation frames: whatever changed has been painted. */
export function paint(page) {
  return page.evaluate(() => new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)))).catch(() => {});
}
