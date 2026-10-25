// Reading the topic map from outside: page positions from force-graph's React
// props (node.x/y) through the canvas's d3-zoom transform, as the film's
// capture tools do. The graph page resets the html zoom to 1; any zoom left is
// multiplied in so positions are viewport px for Playwright's mouse.
import { waitForQuiet } from "./quiet.mjs";

/** Nodes with screen positions, the zoom, and the canvas box. Null when no map is drawn. */
export function readGraph(page) {
  return page.evaluate(() => {
    const canvas = document.querySelector("canvas");
    if (!canvas) return null;
    let el = canvas, fiber = null, host = null;
    while (el && !fiber) {
      const k = Object.keys(el).find((x) => x.startsWith("__reactFiber$"));
      if (k) { fiber = el[k]; host = el; }
      el = el.parentElement;
    }
    // A DOM node's fiber may belong to either of React's two trees, and `return` links mix
    // them, so an earlier render (no pages yet, the map before a focus) can be read by
    // mistake. Walk down from the committed root to this node instead and read the props on
    // that path.
    let top = fiber;
    while (top?.return) top = top.return;
    const path = [];
    let seen = 0;
    const find = (f) => {
      for (let c = f; c && seen < 60000; c = c.sibling) {
        seen++;
        path.push(c);
        if (c.stateNode === host || find(c.child)) return true;
        path.pop();
      }
      return false;
    };
    if (!top?.stateNode?.current || !find(top.stateNode.current)) path.push(fiber);
    let data = null;
    for (let i = path.length - 1; i >= 0 && !data; i--) {
      const pr = path[i].memoizedProps;
      if (pr?.graphData?.nodes) data = pr.graphData;
    }
    let z = canvas;
    while (z && !z.__zoom) z = z.parentNode;
    const t = z?.__zoom ?? { k: 1, x: 0, y: 0 };
    const r = canvas.getBoundingClientRect();
    const Zm = document.documentElement.currentCSSZoom || 1;
    const nodes = (data?.nodes ?? []).filter((n) => typeof n.x === "number").map((n) => ({
      id: n.id, label: n.label ?? n.title ?? n.id, category: n.category ?? null, degree: n.degree ?? 0,
      sx: r.left + (n.x * t.k + t.x) * Zm, sy: r.top + (n.y * t.k + t.y) * Zm,
    }));
    return { k: t.k, tx: t.x, ty: t.y, canvas: { left: r.left, top: r.top, width: r.width, height: r.height }, nodes };
  }).catch(() => null);
}

/** Waits until the layout stops moving (or maxMs), after the page itself is quiet. */
export async function waitForSettledGraph(page, tracker, maxMs = 9000) {
  await waitForQuiet(page, tracker);
  const t0 = Date.now();
  let last = null, still = 0;
  while (Date.now() - t0 < maxMs) {
    const g = await readGraph(page);
    if (g && g.nodes.length) {
      const sig = g.nodes.slice(0, 40).map((n) => `${n.sx.toFixed(0)},${n.sy.toFixed(0)}`).join(";") + `|${g.k.toFixed(3)}`;
      still = sig === last ? still + 1 : 0;
      last = sig;
      if (still >= 3) return g;
    }
    await page.waitForTimeout(250);
  }
  return readGraph(page);
}

/**
 * A page to probe: well connected, its dot inside the free part of the canvas
 * and not under the legend, a panel or a button (checked with elementFromPoint).
 */
export async function pickNode(page, g, { exclude = [] } = {}) {
  if (!g?.nodes.length) return null;
  const vp = page.viewportSize();
  const sorted = [...g.nodes].filter((n) => !exclude.includes(n.id)).sort((a, b) => b.degree - a.degree);
  for (const n of sorted) {
    if (n.sx < 40 || n.sy < 40 || n.sx > vp.width - 40 || n.sy > vp.height - 40) continue;
    const onCanvas = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === "CANVAS", [n.sx, n.sy]);
    if (onCanvas) return n;
  }
  return null;
}

/** A spot on the canvas with no page near it (for "pointer away" and background clicks). */
export async function emptySpot(page, g) {
  const c = g.canvas;
  for (let gx = 0.55; gx < 0.95; gx += 0.1) {
    for (let gy = 0.15; gy < 0.9; gy += 0.15) {
      const x = c.left + c.width * gx, y = c.top + c.height * gy;
      const far = g.nodes.every((n) => Math.hypot(n.sx - x, n.sy - y) > 60);
      const onCanvas = far && (await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === "CANVAS", [x, y]));
      if (onCanvas) return { x, y };
    }
  }
  return null;
}

/** The details panel (the aside the graph page opens), as text facts. */
export function readPanel(page) {
  return page.evaluate(() => {
    const aside = document.querySelector('aside[aria-label="Graph details"]') ?? document.querySelector("main aside");
    if (!aside || !aside.checkVisibility()) return null;
    const h = aside.querySelector("h2,h3");
    const a = document.activeElement;
    return { title: (h?.textContent ?? "").trim(), focusInside: !!a && aside.contains(a), width: Math.round(aside.getBoundingClientRect().width) };
  }).catch(() => null);
}

/** Where keyboard focus is, as "tag[role] name" ("body" when it fell out of the page). */
export function focusedName(page) {
  return page.evaluate(() => {
    const a = document.activeElement;
    if (!a || a === document.body) return "body";
    // A container that takes focus (tabindex -1) is named by its role, not by all the text inside it.
    const container = a.querySelectorAll("*").length > 8;
    const text = container ? "" : (a.innerText || a.textContent || "");
    const name = (a.getAttribute("aria-label") || a.getAttribute("title") || text).replace(/\s+/g, " ").trim().slice(0, 50);
    const tab = a.getAttribute("tabindex");
    return `${a.tagName.toLowerCase()}${a.id ? `#${a.id}` : ""}${a.getAttribute("role") ? `[${a.getAttribute("role")}]` : ""}${tab !== null ? ` tabindex=${tab}` : ""}`
      + (name ? ` "${name}"` : container ? " (a container)" : "");
  }).catch(() => "unknown");
}

/** The "N pages · M connections" counts in the graph header. */
export function headerCounts(page) {
  return page.evaluate(() => {
    const m = (document.querySelector("main header")?.textContent ?? "").match(/(\d+)\s+pages?\s*·\s*(\d+)\s+connections?/);
    const focus = document.querySelector('[role="group"][aria-label="Focus"]');
    return { pages: m ? Number(m[1]) : null, lines: m ? Number(m[2]) : null, focusTitle: focus?.querySelector("span[title]")?.getAttribute("title") ?? null };
  }).catch(() => ({ pages: null, lines: null, focusTitle: null }));
}
