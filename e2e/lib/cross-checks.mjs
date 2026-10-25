// Checks across screens, after the crawl: links that lead nowhere, and the
// counts the main screens state against what the APIs say.
import { MAX_LINK_CHECKS } from "./config.mjs";
import { statusOf } from "./net.mjs";

/** Screens that speak for the whole wiki (their counts should agree with the totals). */
const GLOBAL_SCREENS = [/^\/$/, /^\/wiki$/, /^\/wiki\/graph$/, /^\/sources$/, /^\/settings$/, /^\/feed$/, /^\/sessions$/];

/**
 * Broken internal links: `refs` maps a target route to the routes linking to
 * it; `docStatus` holds the status of routes the crawl loaded. Targets the
 * crawl did not load are fetched once (GET, no browser), up to MAX_LINK_CHECKS.
 */
export async function brokenLinkFindings(store, refs, docStatus, request, base) {
  let checked = 0;
  for (const [target, from] of refs) {
    let status = docStatus.get(target);
    if (status === undefined) {
      if (checked >= MAX_LINK_CHECKS) break;
      checked++;
      status = await statusOf(request, `${base}${target}`);
    }
    if (status && status < 400) continue;
    if (!status) {
      store.add({ route: target, width: null, url: `${base}${target}`, severity: "info", kind: "harness", title: "Links not checked: Kompl did not answer", groupBy: "link unchecked", detail: target });
      continue;
    }
    for (const route of from) {
      store.add({ route, width: null, url: `${base}${route}`, severity: "high", kind: "broken-link",
        title: `Link to ${target} leads to HTTP ${status}`, groupBy: `broken ${target}` });
    }
  }
  return checked;
}

/** The largest headline "N pages" / "N sources" on each main screen (headings, headers, live regions), against the API totals. */
export function countFindings(store, truth) {
  const want = { page: truth.pages, source: truth.sources };
  for (const noun of Object.keys(want)) {
    if (want[noun] == null) continue;
    const said = [];
    for (const [route, list] of Object.entries(store.headCounts ?? {})) {
      if (!GLOBAL_SCREENS.some((re) => re.test(route))) continue;
      const ns = list.filter((c) => c.noun === noun).map((c) => c.n);
      if (ns.length) said.push({ route, n: Math.max(...ns), all: ns });
    }
    const off = said.filter((s) => s.n !== want[noun]);
    if (!off.length) continue;
    const detail = `The API says ${want[noun]} ${noun}s. Headline counts on the main screens:\n` + said.map((s) => `- ${s.route}: ${s.all.join(", ")}`).join("\n")
      + "\nThe largest headline count on each screen is compared; a screen may count a subset on purpose (filters, archived), so read the screenshot.";
    for (const s of off) {
      const shot = store.visits.filter((v) => v.route === s.route && v.screenshot).sort((a, b) => b.width - a.width)[0]?.screenshot ?? null;
      store.add({ route: s.route, width: null, url: s.route, severity: "low", kind: "numbers-disagree", screenshot: shot,
        title: `Main screens disagree on the number of ${noun}s (API: ${want[noun]})`, groupBy: `count ${noun}`, detail });
    }
  }
}
