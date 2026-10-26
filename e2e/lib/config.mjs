// Shared settings for the crawler and the explore-step helper: limits, viewports,
// thresholds and the responses a page is allowed to get. Every limit is a named
// constant so a run can be read back against it.
import path from "node:path";
import { fileURLToPath } from "node:url";

export const E2E_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const APP_DIR = path.resolve(E2E_DIR, "../app/src/app");

export const DEFAULT_BASE = "http://localhost:3000";
/** Kompl instances this suite must never touch (the film wiki). */
export const FORBIDDEN_PORTS = ["3130"];

/**
 * Widths the crawler visits every route at: Kompl runs in a desktop browser
 * only, so a small laptop window, a common laptop and a full HD screen.
 */
export const VIEWPORTS = [
  { name: "1024", width: 1024, height: 768 },
  { name: "1280", width: 1280, height: 800 },
  { name: "1920", width: 1920, height: 1080 },
];
/** The width the interaction probes run at. */
export const PROBE_WIDTH = 1280;

/** Most distinct routes (path + query) one crawl visits, at every width. */
export const MAX_ROUTES = 250;
/** Most variants of one path that differ only in their query string. */
export const MAX_QUERY_VARIANTS = 3;
/** Most internal links checked by a plain GET (links found but not crawled). */
export const MAX_LINK_CHECKS = 400;
/** Wiki pages that get the page-card probes (the best connected first). */
export const PAGE_CARD_PROBES = 4;

/** Quiet = no request in flight and no DOM change for this long. */
export const QUIET_MS = 500;
/** Give up waiting for quiet after this long (the page is then reported as never quiet). */
export const QUIET_TIMEOUT_MS = 15000;
/** A request open longer than this is a long poll or a stream and does not hold quiet back. */
export const LONG_REQUEST_MS = 8000;
/** Navigation timeout for one page load. */
export const NAV_TIMEOUT_MS = 45000;

/** Page load (start to quiet) slower than this is reported; the second threshold raises its severity. */
export const SLOW_LOAD_MS = 5000;
export const VERY_SLOW_LOAD_MS = 10000;
/** One API response slower than this is reported. */
export const SLOW_API_MS = 3000;

/** Full-page screenshots are cut at this height (CSS px) so a long article stays a readable file. */
export const FULL_PAGE_MAX_PX = 4000;
/** Highlight screenshots taken for findings on one visit, at most. */
export const MAX_HIGHLIGHTS_PER_VISIT = 4;
export const JPEG_QUALITY = 62;

/** axe impacts that become findings. */
export const AXE_IMPACTS = ["critical", "serious"];

/**
 * Responses a page expects, so they are not bugs: a 404 that means "nothing
 * there yet" is how some panels learn there is no data. Each entry names why.
 */
export const EXPECTED_RESPONSES = [
  { url: /\/api\/wiki\/[^/?]+\/previous(\?|$)/, status: [404], why: "a page with no earlier version" },
  { url: /\/api\/wiki\/page-upgrade\/notice(\?|$)/, status: [404], why: "no page-upgrade notice to show" },
  { url: /\/favicon\.ico(\?|$)/, status: [404], why: "favicon is optional" },
];

export function isExpectedResponse(url, status) {
  return EXPECTED_RESPONSES.some((e) => e.url.test(url) && e.status.includes(status));
}

/** Reads `--name value` and `--flag` arguments. */
export function parseArgs(argv) {
  const args = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith("--")) { args._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next === undefined || next.startsWith("--")) args[key] = true;
    else { args[key] = next; i++; }
  }
  return args;
}

/** The base URL without a trailing slash; refuses the film wiki and non-http URLs. */
export function checkBase(raw) {
  const base = String(raw || DEFAULT_BASE).replace(/\/+$/, "");
  let u;
  try { u = new URL(base); } catch { throw new Error(`not a URL: ${base}`); }
  if (!/^https?:$/.test(u.protocol)) throw new Error(`only http(s) bases: ${base}`);
  if (FORBIDDEN_PORTS.includes(u.port)) throw new Error(`refusing ${base}: port ${u.port} is the film wiki, held by another session`);
  return base;
}

/** A timestamp usable as a folder name, e.g. 2026-10-23T20-15-02. */
export function runStamp(d = new Date()) {
  const p = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
}

/** A route as a short file-name-safe slug. */
export function slug(route) {
  const s = route.replace(/^\/+/, "").replace(/[?&=#/%:]+/g, "_").replace(/[^\w.-]+/g, "-").replace(/_+$/, "");
  return (s || "home").slice(0, 90);
}

/**
 * A route given on the command line. Git Bash rewrites a leading "/" into its
 * install folder ("/wiki" -> "C:/Program Files/Git/wiki"); that is undone here,
 * and a missing leading slash is added.
 */
export function routeArg(raw) {
  let r = String(raw ?? "/").trim().replace(/\\/g, "/");
  r = r.replace(/^[A-Za-z]:\/(?:Program Files\/)?Git(?=\/|$)/i, "");
  return r.startsWith("/") ? r : `/${r}`;
}
