// What one explore step does to the page. Every click, key and typed text goes
// through the denylist first; the network guard on the context is the second
// line (lib/safety.mjs).
import { routeArg } from "./config.mjs";
import { parseTarget, resolveTarget } from "./explore-targets.mjs";
import { readGraph } from "./graph-util.mjs";
import { assertSafe, assertSafePoint, logSafety, SafetyRefusal } from "./safety.mjs";

/** Playwright's wait for an element to be actionable, shorter than its default. */
export const ACTION_TIMEOUT_MS = 8000;

/** A same-origin URL for a path, never the API. */
export function routeFor(base, raw) {
  const u = new URL(routeArg(raw), base);
  if (u.origin !== new URL(base).origin) throw new SafetyRefusal("other sites are out of scope", raw);
  if (u.pathname.startsWith("/api/")) throw new SafetyRefusal("the API is not a screen; open the page that uses it", raw);
  return u.toString();
}

/** Enter/Space on a control counts as a click; Enter in a field of a saving form is a submit. */
async function assertSafeKey(page, key, locator) {
  if (!/^(Enter|Space| )$/.test(key)) return;
  const el = (locator ?? page.locator(":focus")).first();
  if (!(await el.count())) return;
  await assertSafe(el, `press ${key}`);
  const submits = key === "Enter" && (await el.evaluate((e) => {
    const f = e.closest("form");
    return e.tagName === "INPUT" && !!f && (f.getAttribute("method") ?? "get").toLowerCase() !== "get" && !e.closest('[role="search"]');
  }).catch(() => false));
  if (submits) {
    logSafety({ type: "refused", target: "Enter in a form field", reason: "would submit the form" });
    throw new SafetyRefusal("Enter would submit the form");
  }
}

/** Playwright's actionability error, trimmed to what a reader needs ("... intercepts pointer events"). */
export function explainActionError(e) {
  // eslint-disable-next-line no-control-regex
  const lines = String(e.message).replace(/\x1b\[[0-9;]*m/g, "").split("\n").map((l) => l.trim()).filter(Boolean);
  const why = lines.find((l) => /intercepts pointer events|not visible|not enabled|outside of the viewport|detached/.test(l));
  return `${lines[0]}${why ? ` (${why})` : ""}`;
}

/** Runs one action. Returns { note, fullPage } for the capture. */
export async function act(page, base, { action, a1, a2, full }) {
  const resolve = (raw) => resolveTarget(page, parseTarget(raw));
  const nav = { waitUntil: "domcontentloaded" };
  switch (action) {
    case "goto": await page.goto(routeFor(base, a1), nav); return {};
    case "back": await page.goBack(nav); return {};
    case "forward": await page.goForward(nav); return {};
    case "reload": await page.reload(nav); return {};
    case "snap": return { fullPage: !!full };
    case "click": {
      const t = await resolve(a1);
      if (t.point) { await assertSafePoint(page, t.point.x, t.point.y); await page.mouse.click(t.point.x, t.point.y); }
      else { await assertSafe(t.locator, "click"); await t.locator.click({ timeout: ACTION_TIMEOUT_MS }); }
      return { note: t.note };
    }
    case "hover": {
      const t = await resolve(a1);
      if (t.point) await page.mouse.move(t.point.x, t.point.y, { steps: 5 });
      else await t.locator.hover({ timeout: ACTION_TIMEOUT_MS });
      return { note: t.note };
    }
    case "press": {
      const t = a2 ? await resolve(a2) : null;
      if (t?.point) throw new Error("press takes an element target, not a point");
      await assertSafeKey(page, a1, t?.locator);
      if (t) await t.locator.press(a1, { timeout: ACTION_TIMEOUT_MS }); else await page.keyboard.press(a1);
      return { note: t?.note };
    }
    case "type": {
      if (new URL(page.url()).pathname.startsWith("/settings")) throw new SafetyRefusal("settings fields save on change");
      const t = await resolve(a1);
      if (t.point) throw new Error("type takes an element target");
      if ((await t.locator.evaluate((e) => e.getAttribute("type") ?? "")) === "file") throw new SafetyRefusal("file picker");
      await t.locator.fill(a2 ?? "", { timeout: ACTION_TIMEOUT_MS });
      return { note: t.note };
    }
    case "scroll": {
      const dy = Number(a1 ?? 600);
      if (a2) { const t = await resolve(a2); await t.locator.evaluate((e, dy) => e.scrollBy(0, dy), dy); }
      else await page.mouse.wheel(0, dy);
      await page.waitForTimeout(250);
      return {};
    }
    case "resize": {
      const w = Number(a1), h = Number(a2 ?? page.viewportSize()?.height ?? 800);
      if (!(w > 0 && h > 0)) throw new Error("resize <width> <height>");
      await page.setViewportSize({ width: w, height: h });
      await page.waitForTimeout(300);
      return {};
    }
    case "nodes": {
      const g = await readGraph(page);
      if (!g) throw new Error("no topic map on this screen");
      const list = [...g.nodes].sort((a, b) => b.degree - a.degree)
        .map((n) => `${Math.round(n.sx)},${Math.round(n.sy)}  ${n.label}  (${n.id}, ${n.degree} lines)`);
      return { listing: list.join("\n"), noCapture: true };
    }
    default: throw new Error(`unknown action "${action}"; see the top of explore-step.mjs`);
  }
}
