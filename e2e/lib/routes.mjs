// Where to go: the app's own route files (app/src/app/**/page.tsx), filled in
// from the read APIs (wiki pages, sources, onboarding connectors), then every
// internal link found on the pages visited, up to MAX_ROUTES.
import fs from "node:fs";
import path from "node:path";
import { MAX_QUERY_VARIANTS, MAX_ROUTES } from "./config.mjs";

/** page.tsx files as routes: static ones, and templates with [params]. */
export function discoverAppRoutes(appDir) {
  const found = { static: [], dynamic: [] };
  const walk = (dir, segs) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (entry.name === "api" || entry.name.startsWith("_") || entry.name.startsWith("@")) continue;
        const seg = /^\(.*\)$/.test(entry.name) ? null : entry.name; // route groups add no segment
        walk(path.join(dir, entry.name), seg ? [...segs, seg] : segs);
      } else if (/^page\.(tsx|jsx|ts|js)$/.test(entry.name)) {
        const route = `/${segs.join("/")}`;
        (segs.some((s) => s.startsWith("[")) ? found.dynamic : found.static).push(route);
      }
    }
  };
  walk(appDir, []);
  found.static.sort();
  found.dynamic.sort();
  return found;
}

/** Connector ids from the onboarding picker's source (`id: 'url'`, ...). */
function connectorIds(appDir) {
  try {
    const src = fs.readFileSync(path.join(appDir, "onboarding", "OnboardingClient.tsx"), "utf8");
    return [...src.matchAll(/\{\s*id:\s*'([a-z0-9-]+)'/g)].map((m) => m[1]);
  } catch { return []; }
}

async function getJson(request, url) {
  try {
    const res = await request.get(url, { timeout: 20000 });
    return res.ok() ? await res.json() : null;
  } catch { return null; }
}

/**
 * The seed list, in visiting order: the static screens, the graph, every wiki
 * page (best connected first), every source, the onboarding connectors.
 * Also returns what the APIs say, for the cross-screen count check.
 */
export async function seedRoutes(base, request, appDir) {
  const app = discoverAppRoutes(appDir);
  const index = await getJson(request, `${base}/api/wiki/index`);
  const graph = await getJson(request, `${base}/api/wiki/graph`);
  const sources = await getJson(request, `${base}/api/sources?limit=500`);
  const pages = index?.pages ?? [];
  const degree = new Map((graph?.nodes ?? []).map((n) => [n.id, n.degree ?? 0]));
  const byDegree = [...pages].sort((a, b) => (degree.get(b.page_id) ?? 0) - (degree.get(a.page_id) ?? 0));
  const fill = {
    "/wiki/[page_id]": byDegree.map((p) => `/wiki/${encodeURIComponent(p.page_id)}`),
    "/source/[source_id]": (sources?.sources ?? []).map((s) => `/source/${encodeURIComponent(s.source_id)}`),
    "/onboarding/[connector]": connectorIds(appDir).map((c) => `/onboarding/${c}?session_id=e2e-readonly`),
  };
  const seeds = [...app.static];
  const top = byDegree[0]?.page_id;
  if (top) seeds.push(`/wiki/graph?focus=${encodeURIComponent(top)}`);
  const word = pages[0]?.title?.split(/\s+/).find((w) => w.length > 3);
  if (word) seeds.push(`/wiki/search?q=${encodeURIComponent(word)}`);
  const unfilled = [];
  // Filled templates in the order of `fill` (wiki pages first), then any the app adds later.
  const order = [...Object.keys(fill).filter((t) => app.dynamic.includes(t)), ...app.dynamic.filter((t) => !(t in fill))];
  for (const t of order) {
    if (fill[t]?.length) seeds.push(...fill[t]);
    else unfilled.push(t);
  }
  return {
    seeds, app, unfilled,
    truth: {
      pages: index?.total_pages ?? pages.length,
      sources: sources?.total ?? sources?.sources?.length ?? null,
      graphNodes: graph?.nodes?.length ?? null,
      categories: index?.categories?.length ?? null,
    },
    pages, graph,
  };
}

const SKIP_EXT = /\.(png|jpe?g|gif|svg|webp|ico|pdf|zip|gz|json|xml|txt|md|csv|js|css|map|woff2?)$/i;

/** A same-origin link as a route to visit ("/wiki/x?y=1"), or null when it is not one. */
export function toRoute(href, base) {
  let u;
  try { u = new URL(href, base); } catch { return null; }
  if (u.origin !== new URL(base).origin) return null;
  if (u.pathname.startsWith("/api/") || u.pathname.startsWith("/_next/") || SKIP_EXT.test(u.pathname)) return null;
  u.searchParams.delete("_rsc");
  const q = u.searchParams.toString();
  return `${u.pathname}${q ? `?${q}` : ""}`;
}

/** The crawl queue: seeds first, then links as they are found, capped. */
export function createQueue(maxRoutes = MAX_ROUTES) {
  const seen = new Set();
  const variants = new Map();
  const queue = [];
  let dropped = 0;
  return {
    add(route) {
      if (!route || seen.has(route)) return false;
      const p = route.split("?")[0];
      const n = variants.get(p) ?? 0;
      if (route.includes("?") && n >= MAX_QUERY_VARIANTS) return false;
      if (seen.size >= maxRoutes) { dropped++; return false; }
      seen.add(route);
      variants.set(p, n + 1);
      queue.push(route);
      return true;
    },
    next() { return queue.shift(); },
    get size() { return seen.size; },
    get dropped() { return dropped; },
    has(route) { return seen.has(route); },
  };
}
