// One route at one width: load, wait for quiet, screenshot, check the DOM, run
// axe, turn the browser's events into findings.
import { FULL_PAGE_MAX_PX, NAV_TIMEOUT_MS, SLOW_LOAD_MS, VERY_SLOW_LOAD_MS } from "./config.mjs";
import { axeFindings } from "./axe.mjs";
import { eventFindings, shortUrl } from "./collect.mjs";
import { domChecks } from "./dom-checks.mjs";
import { gotoWithRetry, TRANSIENT_NET } from "./net.mjs";
import { waitForQuiet } from "./quiet.mjs";
import { highlightShot, stateShot } from "./store.mjs";

/** Adds findings to the store; a new group with a selector gets a highlight screenshot. */
export async function addFindings(page, store, findings, fallbackShot) {
  for (const f of findings) {
    if (f.selector && !store.has(f.kind, f.groupBy ?? f.title) && store.takeHighlight()) {
      const wide = f.kind === "overflow" || f.kind === "clipped";
      f.screenshot = (await highlightShot(page, store, f.selector, `${f.kind}-${f.route}-${f.width}`, { fullPage: wide })) ?? fallbackShot;
    }
    f.screenshot ??= fallbackShot;
    store.add(f);
  }
}

/** DOM check results as findings. */
export function domFindings(dom, where) {
  const out = [];
  const f = (o) => out.push({ ...where, ...o });
  if (dom.appError) f({ severity: "critical", kind: "app-error", title: `Error screen: ${dom.appError}` });
  if (dom.notFound && where.status < 400) f({ severity: "high", kind: "not-found", title: `"Not found" screen served as HTTP ${where.status} at ${where.route}`, groupBy: `not found ${where.route}` });
  if (dom.hScroll > 0) {
    const c = dom.overflow[0];
    f({ severity: "medium", kind: "overflow", selector: c?.sel ?? null,
      title: `Page scrolls sideways${c ? `: ${c.sel.split(" > ").slice(-2).join(" > ")}${c.text ? ` "${c.text.slice(0, 40)}"` : ""} reaches past the screen` : ""}`,
      groupBy: `overflow ${c?.sel ?? where.route}`,
      detail: `Scrolls ${dom.hScroll} px sideways at ${dom.vw} px wide.\n` + dom.overflow.map((o) => `- ${o.sel} (right edge ${o.right} px) "${o.text}"`).join("\n") });
  }
  for (const c of dom.clipped) f({ severity: "medium", kind: "clipped", selector: c.sel, title: `Cut off at the ${c.edge} screen edge: "${c.text || c.sel}"`,
    groupBy: `clipped ${c.edge} ${c.sel}`, detail: `${c.sel}\nspans ${c.left}..${c.right} px on a ${dom.vw} px screen; the page cannot scroll to it.` });
  for (const c of dom.cutText) f({ severity: "low", kind: "cut-text", selector: c.sel, title: `Text cut off (${c.how}): "${c.text}"`, groupBy: `cut ${c.how} ${c.sel}`, detail: c.sel });
  for (const c of dom.ellipsisNoTitle) f({ severity: "info", kind: "ellipsis-no-title", selector: c.sel, title: `Shortened with "…" and no way to read it in full: "${c.text}"`, groupBy: `ellipsis ${c.sel}`, detail: c.sel });
  for (const c of dom.emptyHeadings) f({ severity: "medium", kind: "empty-heading", selector: c.sel, title: "Empty heading", groupBy: `empty heading ${c.sel}`, detail: c.sel });
  for (const c of dom.covered) f({ severity: "medium", kind: "covered", selector: c.sel, title: `Control covered by another element: "${c.name}"`,
    groupBy: `covered ${c.sel}`, detail: `${c.sel}\nits middle is under ${c.by} "${c.byText}"` });
  for (const c of dom.brokenImages) f({ severity: "medium", kind: "broken-image", selector: c.sel, title: `Broken image: ${shortUrl(c.src)}`, detail: c.src });
  for (const c of dom.brokenAnchors) f({ severity: "medium", kind: "broken-anchor", selector: c.sel, title: `In-page link to a missing anchor ${c.href}`, groupBy: `anchor ${c.sel}`, detail: `"${c.text}" -> ${c.href}` });
  for (const c of dom.badText) f({ severity: "high", kind: "bad-text", selector: c.sel, title: `Broken text on screen: "${c.text}"`, detail: c.sel });
  return out;
}

/**
 * Visits `route` in `session`. Returns what the crawl needs next (links,
 * counts, status) and records findings and the visit in the store.
 */
export async function visitRoute(session, store, base, route, { axe = true, blockedNow = [] } = {}) {
  const { page, tracker, collectors, vp } = session;
  const where = { route, width: vp.width, url: `${base}${route}` };
  collectors.reset();
  blockedNow.length = 0;
  const visit = store.startVisit({ route, width: vp.width });
  let t0 = Date.now();
  let res;
  try {
    res = await gotoWithRetry(page, where.url, { waitUntil: "domcontentloaded", timeout: NAV_TIMEOUT_MS }, () => {
      t0 = Date.now();
      collectors.reset();
    });
  } catch (e) {
    visit.error = e.message.split("\n")[0];
    const shot = await stateShot(page, store, `navfail-${route}-${vp.width}`);
    // Still a network error after waiting for Kompl: the machine or the stack, not this page.
    const machine = TRANSIENT_NET.test(visit.error);
    store.add({ ...where, severity: machine ? "info" : "critical", kind: machine ? "harness" : "navigation", screenshot: shot,
      title: machine ? `Could not reach Kompl for this page (${visit.error.match(TRANSIENT_NET)[0]})` : `Page did not load: ${visit.error.slice(0, 140)}`,
      groupBy: machine ? "unreachable" : `nav ${route}` });
    return { links: [], counts: [], headCounts: [], status: 0 };
  }
  visit.status = res?.status() ?? 0;
  visit.dclMs = Date.now() - t0;
  const quiet = await waitForQuiet(page, tracker);
  visit.loadMs = Date.now() - t0;
  visit.finalUrl = page.url();
  visit.screenshot = await stateShot(page, store, `${route}-${vp.width}`, { fullPage: true, maxHeight: FULL_PAGE_MAX_PX });
  const shot = visit.screenshot;
  const findings = [];
  if (!quiet.quiet) findings.push({ ...where, severity: "low", kind: "never-quiet", title: `Never settled within ${quiet.ms} ms (${quiet.why} kept changing)`, groupBy: `never quiet ${quiet.why} ${route.split("/")[1]}` });
  if (visit.loadMs > SLOW_LOAD_MS && quiet.quiet) {
    findings.push({ ...where, severity: visit.loadMs > VERY_SLOW_LOAD_MS ? "high" : "medium", kind: "slow-load",
      title: `Slow load: ${visit.loadMs} ms to settle`, groupBy: `slow ${route}`, detail: `DOMContentLoaded after ${visit.dclMs} ms` });
  }

  let dom = null;
  try { dom = await page.evaluate(domChecks, {}); } catch (e) {
    findings.push({ ...where, severity: "info", kind: "harness", title: `DOM checks failed: ${e.message.slice(0, 120)}` });
  }
  if (dom) findings.push(...domFindings(dom, { ...where, status: visit.status }).map(({ status, ...f }) => f));
  if (axe) findings.push(...(await axeFindings(page, where)));
  // An error right after the guard aborted a write is the guard's doing, not the app's.
  const guarded = blockedNow.length > 0;
  for (const f of eventFindings(collectors.drain(), where)) {
    if (guarded && /Failed to fetch|NetworkError|Load failed|ERR_BLOCKED/i.test(f.title)) {
      findings.push({ ...f, severity: "info", detail: `${f.detail ?? ""}\nLikely caused by the guard blocking a write on this visit.`.trim() });
    } else findings.push(f);
  }
  for (const b of blockedNow) {
    findings.push({ ...where, severity: "medium", kind: "write-on-load", title: `Page sent a write on its own (blocked): ${b.method} ${shortUrl(b.url)}`,
      groupBy: `write ${b.method} ${shortUrl(b.url)}`, detail: "The crawler only loads pages; nothing was clicked. The guard aborted this request." });
  }
  await addFindings(page, store, findings, shot);
  visit.findings = findings.length;
  visit.title = dom?.title ?? "";
  return { links: dom?.links ?? [], counts: dom?.counts ?? [], headCounts: dom?.headCounts ?? [], status: visit.status, finalUrl: visit.finalUrl };
}
