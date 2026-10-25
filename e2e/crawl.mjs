// Kompl bug-hunting crawler (read-only).
//   npm run crawl -- --base http://localhost:3000
// Options:
//   --base <url>        the running Kompl (default http://localhost:3000; the film wiki on :3130 is refused)
//   --max <n>           route cap (default MAX_ROUTES in lib/config.mjs)
//   --widths 1024,1920   only these widths
//   --routes /a,/b      visit only these routes (no seeding, no link harvest)
//   --run <name>        output folder name under out/ (default: a timestamp)
//   --no-axe            skip the accessibility scan
//   --no-probes         skip the graph and page-card interaction probes
// Writes out/<run>/findings.json and out/<run>/index.html (with shots/).
import path from "node:path";
import { request } from "playwright";
import { launchBrowser, openSession } from "./lib/browser.mjs";
import { APP_DIR, checkBase, E2E_DIR, MAX_ROUTES, PAGE_CARD_PROBES, parseArgs, PROBE_WIDTH, routeArg, runStamp, VIEWPORTS } from "./lib/config.mjs";
import { brokenLinkFindings, countFindings } from "./lib/cross-checks.mjs";
import { runGraphProbes } from "./lib/probes-graph.mjs";
import { runPageProbes } from "./lib/probes-page.mjs";
import { writeReport } from "./lib/report.mjs";
import { createQueue, seedRoutes, toRoute } from "./lib/routes.mjs";
import { safetyLog } from "./lib/safety.mjs";
import { createStore, SEVERITIES } from "./lib/store.mjs";
import { visitRoute } from "./lib/visit.mjs";

const args = parseArgs(process.argv.slice(2));
const base = checkBase(args.base);
const maxRoutes = Number(args.max ?? MAX_ROUTES);
const widths = args.widths ? String(args.widths).split(",").map(Number) : null;
const viewports = widths ? widths.map((w) => VIEWPORTS.find((v) => v.width === w) ?? { name: String(w), width: w, height: 900 }) : VIEWPORTS;
const run = String(args.run ?? runStamp());
const store = createStore(path.join(E2E_DIR, "out", run));
store.probeLog = [];
store.counts = {};
store.headCounts = {};
store.guardLog = safetyLog;
const startedAt = new Date().toISOString();

const api = await request.newContext({ timeout: 20000 });
try {
  const res = await api.get(`${base}/api/health`);
  if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
} catch (e) {
  console.error(`Kompl is not answering at ${base} (${e.message.split("\n")[0]}). Start it, or pass --base.`);
  process.exit(2);
}

const seed = await seedRoutes(base, api, APP_DIR);
const queue = createQueue(maxRoutes);
const fixed = args.routes ? String(args.routes).split(",").filter((r) => r.trim()).map(routeArg) : null;
for (const r of fixed ?? seed.seeds) queue.add(r);
for (const t of seed.unfilled) {
  store.add({ route: t, width: null, url: null, severity: "info", kind: "coverage", title: `Route template not crawled: ${t} (no data to fill it)` });
}
console.log(`${base}: ${seed.app.static.length} static routes, ${seed.pages.length} wiki pages, ${queue.size} routes queued; widths ${viewports.map((v) => v.width).join(", ")}`);

const browser = await launchBrowser();
const sessions = [];
for (const vp of viewports) {
  const blockedNow = [];
  const s = await openSession(browser, vp, base, { onBlock: (e) => blockedNow.push(e) });
  s.blockedNow = blockedNow;
  sessions.push(s);
}

const refs = new Map();
const docStatus = new Map();
let finished = false;
/** Writes findings.json and index.html as they stand (also every REPORT_EVERY routes, so a killed run leaves a report). */
const write = (done) => writeReport(store, {
  run, base, startedAt, finishedAt: done ? new Date().toISOString() : "(still running)", routes: queue.size, maxRoutes, dropped: queue.dropped,
  viewports: viewports.map((v) => v.width), truth: seed.truth,
});
const REPORT_EVERY = 10;
const finish = async () => {
  if (finished) return;
  finished = true;
  const json = write(true);
  const by = Object.fromEntries(SEVERITIES.map((s) => [s, json.findings.filter((f) => f.severity === s).length]));
  console.log(`\nfindings: ${SEVERITIES.map((s) => `${s} ${by[s]}`).join(", ")}; guard log ${safetyLog.length} entries`);
  console.log(`report: ${path.join(store.outDir, "index.html")}`);
};
process.on("SIGINT", async () => { console.log("\ninterrupted: writing what there is"); await finish(); process.exit(130); });

let n = 0;
for (let route = queue.next(); route; route = queue.next()) {
  n++;
  const t0 = Date.now();
  let found = 0;
  for (const s of sessions) {
    const r = await visitRoute(s, store, base, route, { axe: !args["no-axe"], blockedNow: s.blockedNow });
    if (r.status > 0 && (!docStatus.has(route) || r.status >= 400)) docStatus.set(route, r.status);
    if (s === sessions.at(-1)) { store.counts[route] = r.counts; store.headCounts[route] = r.headCounts; }
    if (fixed) continue;
    for (const link of r.links) {
      const target = toRoute(link, base);
      if (!target || target === route) continue;
      if (!refs.has(target)) refs.set(target, new Set());
      refs.get(target).add(route);
      if (queue.add(target)) found++;
    }
  }
  console.log(`[${n}/${queue.size}] ${route}  ${Date.now() - t0} ms${found ? `, +${found} links` : ""}`);
  if (n % REPORT_EVERY === 0) write(false);
}

const checked = await brokenLinkFindings(store, refs, docStatus, api, base);
console.log(`links: ${refs.size} internal targets, ${checked} fetched outside the crawl`);

if (!args["no-probes"]) {
  const s = sessions.find((x) => x.vp.width === PROBE_WIDTH) ?? sessions.at(-1);
  console.log(`probes at ${s.vp.width} px`);
  await runGraphProbes(store, s, base);
  const degree = new Map((seed.graph?.nodes ?? []).map((x) => [x.id, x.degree ?? 0]));
  const top = [...seed.pages].sort((a, b) => (degree.get(b.page_id) ?? 0) - (degree.get(a.page_id) ?? 0)).slice(0, PAGE_CARD_PROBES);
  await runPageProbes(store, s, base, top);
}

countFindings(store, seed.truth);
await finish();
await browser.close();
await api.dispose();
