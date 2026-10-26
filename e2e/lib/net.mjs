// Network hiccups that are the machine's, not the app's: the laptop sleeping
// mid-run (ERR_NETWORK_IO_SUSPENDED), Docker re-plumbing its network
// (ERR_NETWORK_CHANGED), the stack restarting. On one of these the crawler
// waits for Kompl to answer again and retries, instead of reporting every page
// as broken.

export const TRANSIENT_NET = /ERR_NETWORK_IO_SUSPENDED|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED|ERR_CONNECTION_(RESET|REFUSED|ABORTED|CLOSED)|ERR_ADDRESS_UNREACHABLE|ERR_EMPTY_RESPONSE|ECONNREFUSED|ECONNRESET|socket hang up/;
/** Errors that only ever come from the machine, never from the app (ignored in the event log). */
export const MACHINE_NET = /ERR_NETWORK_IO_SUSPENDED|ERR_NETWORK_CHANGED|ERR_INTERNET_DISCONNECTED/;
/** How long to wait for Kompl to come back before giving up on a page. */
export const APP_WAIT_MS = 180000;
/** Retries of one page load after a hiccup. */
export const NAV_RETRIES = 2;

/** Waits until /api/health answers (or maxMs). Returns whether it did. */
export async function waitForApp(base, maxMs = APP_WAIT_MS) {
  const t0 = Date.now();
  while (Date.now() - t0 < maxMs) {
    try {
      const res = await fetch(`${new URL(base).origin}/api/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) return true;
    } catch { /* not back yet */ }
    await new Promise((r) => setTimeout(r, 2000));
  }
  return false;
}

/**
 * page.goto that rides out a hiccup: waits for the app, then tries again.
 * `onRetry` runs before each new attempt (the caller restarts its clock and
 * drops the events of the outage).
 */
export async function gotoWithRetry(page, url, opts = {}, onRetry) {
  for (let attempt = 0; ; attempt++) {
    try {
      if (attempt) onRetry?.();
      return await page.goto(url, opts);
    } catch (e) {
      if (attempt >= NAV_RETRIES || !TRANSIENT_NET.test(e.message)) throw e;
      console.log(`  network hiccup on ${url} (${e.message.match(TRANSIENT_NET)[0]}); waiting for Kompl`);
      await waitForApp(url);
    }
  }
}

/** GET status of a URL outside the browser, riding out one hiccup; 0 when it never answered. */
export async function statusOf(request, url) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try { return (await request.get(url, { timeout: 20000, maxRedirects: 5 })).status(); } catch (e) {
      if (!TRANSIENT_NET.test(e.message) || attempt) return 0;
      await waitForApp(url);
    }
  }
  return 0;
}
