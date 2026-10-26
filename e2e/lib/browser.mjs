// One browser, one context per viewport, each with the network guard, the quiet
// probe and the event collectors on its page.
import { chromium } from "playwright";
import { attachCollectors } from "./collect.mjs";
import { QUIET_INIT, trackRequests } from "./quiet.mjs";
import { attachDialogGuard, DESCRIBE_INIT, installNetworkGuard } from "./safety.mjs";

export function launchBrowser() {
  // Playwright's own Chromium (PLAYWRIGHT_BROWSERS_PATH on this machine), headless.
  return chromium.launch({ headless: true });
}

/** Context options every session shares: no downloads, no service workers, the app's dark look. */
export const CONTEXT_OPTIONS = {
  acceptDownloads: false,
  serviceWorkers: "block",
  colorScheme: "dark",
  locale: "en-GB",
  deviceScaleFactor: 1,
};

/**
 * A guarded page at one viewport. `onBlock` hears about each blocked write
 * (with the page it came from) so the visit can report a page that writes
 * on its own.
 */
export async function openSession(browser, vp, base, { onBlock } = {}) {
  const context = await browser.newContext({ ...CONTEXT_OPTIONS, viewport: { width: vp.width, height: vp.height } });
  const blocked = await installNetworkGuard(context, { onBlock });
  await context.addInitScript(QUIET_INIT);
  await context.addInitScript(DESCRIBE_INIT);
  const page = await context.newPage();
  attachDialogGuard(page);
  page.on("popup", (p) => p.close().catch(() => {}));
  const tracker = trackRequests(page);
  const collectors = attachCollectors(page, base);
  return { vp, context, page, tracker, collectors, blocked };
}
