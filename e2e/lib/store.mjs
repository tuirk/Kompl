// Findings, grouped: the same problem on 70 wiki pages is one finding with 70
// places, its first screenshot and the list of where else it was seen.
import fs from "node:fs";
import path from "node:path";
import { FULL_PAGE_MAX_PX, JPEG_QUALITY, MAX_HIGHLIGHTS_PER_VISIT, slug } from "./config.mjs";

export const SEVERITIES = ["critical", "high", "medium", "low", "info"];
const rank = (s) => SEVERITIES.indexOf(s);

/** Ids, hashes, numbers and quoted values out, so one problem on many pages groups together. */
export function normalize(text) {
  return String(text ?? "")
    .replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, "<id>")
    .replace(/\b[a-z0-9]+(?:-[a-z0-9]+)*-[0-9a-f]{8}\b/gi, "<page>")
    .replace(/\b[0-9a-f]{12,}\b/gi, "<hex>")
    .replace(/\d+(\.\d+)?/g, "#")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 300);
}

export function createStore(outDir) {
  const shotsDir = path.join(outDir, "shots");
  fs.mkdirSync(shotsDir, { recursive: true });
  const groups = new Map();
  const visits = [];
  let highlightsThisVisit = 0;
  let shotN = 0;

  const store = {
    outDir,
    shotsDir,
    visits,
    groups,
    /** A new screenshot path (relative to outDir) with a readable name. */
    shotName(label) {
      shotN++;
      return `shots/${String(shotN).padStart(4, "0")}-${slug(label)}.jpg`;
    },
    abs(rel) { return path.join(outDir, rel); },
    startVisit(v) { highlightsThisVisit = 0; visits.push(v); return v; },
    /**
     * Adds one occurrence. Returns true when it opened a new group (the caller
     * may then take a highlight screenshot for it).
     */
    add(f) {
      const key = `${f.kind}|${normalize(f.groupBy ?? f.title)}`;
      const at = { route: f.route, width: f.width, url: f.url, screenshot: f.screenshot ?? null };
      let g = groups.get(key);
      if (!g) {
        g = { id: `F${String(groups.size + 1).padStart(3, "0")}`, key, severity: f.severity, kind: f.kind, title: f.title,
          detail: f.detail ?? "", selector: f.selector ?? null, screenshot: f.screenshot ?? null, occurrences: [] };
        groups.set(key, g);
      }
      if (rank(f.severity) < rank(g.severity)) g.severity = f.severity;
      if (!g.screenshot && f.screenshot) g.screenshot = f.screenshot;
      if (g.occurrences.length < 200) g.occurrences.push(at);
      else g.more = (g.more ?? 0) + 1;
      return g.occurrences.length === 1 ? g : null;
    },
    /** Whether a group exists already for this kind and title. */
    has(kind, title) { return groups.has(`${kind}|${normalize(title)}`); },
    /** Whether one more highlight screenshot fits in this visit's budget. */
    takeHighlight() {
      if (highlightsThisVisit >= MAX_HIGHLIGHTS_PER_VISIT) return false;
      highlightsThisVisit++;
      return true;
    },
    list() {
      return [...groups.values()].sort((a, b) => rank(a.severity) - rank(b.severity) || b.occurrences.length - a.occurrences.length);
    },
  };
  return store;
}

/**
 * Screenshot with a red outline on `selector` (scrolled into view first).
 * `fullPage` keeps the whole page width, for content that reaches past the
 * screen edge. Returns the relative path, or null when it is not there.
 */
export async function highlightShot(page, store, selector, label, { fullPage = false } = {}) {
  const ok = await page.evaluate((sel) => {
    const el = document.querySelector(sel);
    if (!el) return false;
    el.scrollIntoView({ block: "center", inline: "nearest" });
    window.__e2eOutline = { el, outline: el.style.outline, offset: el.style.outlineOffset };
    el.style.outline = "3px solid #ff2d55";
    el.style.outlineOffset = "1px";
    return true;
  }, selector).catch(() => false);
  if (!ok) return null;
  const rel = fullPage ? await stateShot(page, store, label, { fullPage: true, maxHeight: FULL_PAGE_MAX_PX }) : store.shotName(label);
  if (!fullPage) await page.screenshot({ path: store.abs(rel), type: "jpeg", quality: JPEG_QUALITY }).catch(() => {});
  await page.evaluate(() => {
    const o = window.__e2eOutline;
    if (o) { o.el.style.outline = o.outline; o.el.style.outlineOffset = o.offset; }
    window.__e2eOutline = null;
  }).catch(() => {});
  return rel;
}

/** Viewport screenshot, or the full page (its whole width) cut at maxHeight. */
export async function stateShot(page, store, label, { fullPage = false, maxHeight } = {}) {
  const rel = store.shotName(label);
  const opts = { path: store.abs(rel), type: "jpeg", quality: JPEG_QUALITY };
  if (fullPage) {
    // The root's scroll sizes are viewport px already (the html zoom is inside them).
    const doc = await page.evaluate(() => ({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })).catch(() => null);
    const vp = page.viewportSize();
    if (maxHeight && doc && vp && doc.h > maxHeight) opts.clip = { x: 0, y: 0, width: Math.max(vp.width, doc.w), height: maxHeight };
    opts.fullPage = true;
  }
  await page.screenshot(opts).catch(() => page.screenshot({ path: store.abs(rel), type: "jpeg", quality: JPEG_QUALITY }).catch(() => {}));
  return rel;
}
