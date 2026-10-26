// Interaction probes on the topic map (/wiki/graph): hover, click, Escape,
// Focus and Back, zoom during a fit, filters hiding the selection, the resize
// grips by keyboard, and "Find a page". Each checks what should be true after.
import { emptySpot, focusedName, headerCounts, pickNode, readGraph, readPanel, waitForSettledGraph } from "./graph-util.mjs";
import { gotoWithRetry } from "./net.mjs";
import { runProbe, skip } from "./probe.mjs";
import { assertSafe, assertSafePoint, safeClick } from "./safety.mjs";

const ROUTE = "/wiki/graph";
const norm = (s) => String(s ?? "").replace(/\s+/g, " ").trim().toLowerCase();
const sameTitle = (a, b) => !!a && !!b && (norm(a) === norm(b) || norm(a).startsWith(norm(b)) || norm(b).startsWith(norm(a)));

async function openGraph(p, query = "") {
  await gotoWithRetry(p.page, `${p.base}${ROUTE}${query}`, { waitUntil: "domcontentloaded" });
  const g = await waitForSettledGraph(p.page, p.session.tracker);
  if (!g || !g.nodes.length) skip("no map drawn (empty wiki or no canvas)");
  return g;
}

async function clickNode(p, n) {
  await assertSafePoint(p.page, n.sx, n.sy);
  await p.page.mouse.click(n.sx, n.sy);
  await p.quiet();
}

const nameVisible = (page, label) => page.evaluate((label) => [...document.querySelectorAll("body *")].some((el) =>
  el.childElementCount === 0 && el.textContent.trim() === label && el.checkVisibility({ visibilityProperty: true, opacityProperty: true })
  && !el.closest("header, aside, datalist, section[data-legend], option")), label);

async function hover(p) {
  const g = await openGraph(p);
  const n = (await pickNode(p.page, g)) ?? skip("no page dot clear of the panels");
  await p.page.mouse.move(n.sx, n.sy, { steps: 5 });
  await p.page.waitForTimeout(400);
  await p.expect(await nameVisible(p.page, n.label), "pointing at a page shows its name", { severity: "medium", detail: `"${n.label}" at ${Math.round(n.sx)},${Math.round(n.sy)}` });
  const spot = await emptySpot(p.page, g);
  if (!spot) return;
  await p.page.mouse.move(spot.x, spot.y, { steps: 5 });
  await p.page.waitForTimeout(400);
  await p.expect(!(await nameVisible(p.page, n.label)), "the name goes away when the pointer leaves the page", { severity: "low" });
}

async function clickAndEscape(p) {
  const g = await openGraph(p);
  const n = (await pickNode(p.page, g)) ?? skip("no page dot clear of the panels");
  await clickNode(p, n);
  const panel = await readPanel(p.page);
  await p.expect(panel && sameTitle(panel.title, n.label), "clicking a page opens its panel with its title", { detail: `clicked "${n.label}"; panel: ${panel ? `"${panel.title}"` : "none"}` });
  if (!panel) return;
  await p.expect(panel.focusInside, "keyboard focus moves into the panel", { severity: "medium", detail: `focus on ${await focusedName(p.page)}` });
  await p.page.keyboard.press("Escape");
  await p.quiet();
  const after = await readPanel(p.page);
  const f = await focusedName(p.page);
  await p.expect(!after, "Escape closes the panel", { severity: "medium" });
  await p.expect(f !== "body", "focus stays in the page after Escape", { severity: "medium", detail: `focus on ${f}` });
}

async function focusAndBack(p) {
  const g = await openGraph(p);
  const full = await headerCounts(p.page);
  const n = (await pickNode(p.page, g)) ?? skip("no page dot clear of the panels");
  await clickNode(p, n);
  const btn = p.page.locator('aside[aria-label="Graph details"], main aside').getByRole("button", { name: /^Focus$/ }).first();
  if (!(await btn.count())) skip("no Focus button in the panel");
  await safeClick(btn);
  await waitForSettledGraph(p.page, p.session.tracker);
  const focused = await headerCounts(p.page);
  const url = new URL(p.page.url());
  await p.expect(url.searchParams.get("focus") === n.id, "Focus puts the page in the address", { detail: p.page.url() });
  await p.expect(sameTitle(focused.focusTitle, n.label), "the header names the focused page", { severity: "medium", detail: `header: "${focused.focusTitle}", page: "${n.label}"` });
  await p.expect(focused.pages !== null && full.pages !== null && focused.pages <= full.pages, "the focused map shows no more pages than the full map",
    { severity: "medium", detail: `full map ${full.pages} pages, focused ${focused.pages}` });
  await p.page.goBack({ waitUntil: "domcontentloaded" });
  await waitForSettledGraph(p.page, p.session.tracker);
  const back = await headerCounts(p.page);
  const backUrl = new URL(p.page.url());
  await p.expect(backUrl.pathname === ROUTE && !backUrl.searchParams.get("focus"), "Back leaves the focus and stays on the map", { detail: p.page.url() });
  await p.expect(!back.focusTitle && back.pages === full.pages, "Back restores the full map", { detail: `full ${full.pages} pages; after Back ${back.pages}, focus "${back.focusTitle ?? ""}"` });
}

async function zoomDuringFit(p) {
  await openGraph(p);
  const btn = (name) => p.page.getByRole("button", { name, exact: true }).first();
  const [zin, zout, fit] = [btn("Zoom in"), btn("Zoom out"), btn("Fit the map")];
  if (!(await fit.count()) || !(await zin.count()) || !(await zout.count())) skip("no zoom / fit buttons");
  for (const b of [zin, zout, fit]) await assertSafe(b);
  await fit.click();
  await p.page.waitForTimeout(900);
  const kFit = (await readGraph(p.page)).k;
  for (let i = 0; i < 3; i++) { await zout.click(); await p.page.waitForTimeout(450); }
  const kOut = (await readGraph(p.page)).k;
  await p.expect(kOut < kFit * 0.9, "Zoom out zooms out", { severity: "medium", detail: `fitted ${kFit.toFixed(3)}, after 3 presses ${kOut.toFixed(3)}` });
  const [bf, bi] = [await fit.boundingBox(), await zin.boundingBox()];
  await p.page.mouse.click(bf.x + bf.width / 2, bf.y + bf.height / 2);
  await p.page.waitForTimeout(60);
  await p.page.mouse.click(bi.x + bi.width / 2, bi.y + bi.height / 2);
  await p.page.waitForTimeout(1300);
  const kEnd = (await readGraph(p.page)).k;
  const detail = `fitted zoom ${kFit.toFixed(3)}; zoomed out to ${kOut.toFixed(3)}; pressed Fit, then Zoom in 60 ms later; ended at ${kEnd.toFixed(3)}`;
  await p.expect(Math.abs(kEnd / kFit - 1) > 0.03, "a zoom press during a fit is not undone by the fit", { detail });
  await p.expect(kEnd > kOut * 1.05, "Zoom in pressed during a fit still zooms in", { severity: "medium", detail });
}

/** Opens a collapsed legend (the "Filters" button). */
async function expandLegend(p) {
  const legend = p.page.locator('section[data-legend="filters"]');
  if (!(await legend.count()) || (await legend.first().isVisible())) return;
  const open = p.page.getByRole("button", { name: /^Filters/ }).first();
  if (await open.count()) { await safeClick(open); await p.quiet(); }
}

async function legendRow(p, category) {
  await expandLegend(p);
  const rows = p.page.locator("label").filter({ hasText: new RegExp(`^\\s*${category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\s*\\d*\\s*$`) });
  return (await rows.count()) ? rows.first() : null;
}

async function filterHidesSelection(p) {
  const g = await openGraph(p);
  const n = (await pickNode(p.page, g, { exclude: g.nodes.filter((x) => !x.category).map((x) => x.id) })) ?? skip("no categorised page clear of the panels");
  await clickNode(p, n);
  if (!(await readPanel(p.page))) skip("clicking a page opened no panel");
  const row = (await legendRow(p, n.category)) ?? skip(`no legend row for category "${n.category}"`);
  await safeClick(row);
  await p.quiet();
  const gone = await readPanel(p.page);
  const f1 = await focusedName(p.page);
  await p.expect(!gone, "hiding the selected page's category closes its panel", { severity: "medium", detail: `category "${n.category}"` });
  await p.expect(f1 !== "body", "focus stays on the filter when the panel goes", { severity: "medium", detail: `focus on ${f1}` });
  await safeClick(row);
  await p.quiet();
  const back = await readPanel(p.page);
  await p.expect(back && sameTitle(back.title, n.label), "showing the category again brings the panel back", { severity: "medium", detail: `panel: ${back ? `"${back.title}"` : "none"}` });
  await p.expect(back && !back.focusInside, "the panel coming back leaves focus in the legend", { severity: "low", detail: `focus on ${await focusedName(p.page)}` });
}

const gripFacts = (grip) => grip.evaluate((el) => {
  const target = document.getElementById(el.getAttribute("aria-controls") ?? "");
  return { now: Number(el.getAttribute("aria-valuenow")), min: Number(el.getAttribute("aria-valuemin")), max: Number(el.getAttribute("aria-valuemax")),
    drawn: target ? Math.round(target.getBoundingClientRect().width) : null, right: target ? Math.round(target.getBoundingClientRect().right) : null,
    focused: document.activeElement === el };
});

async function tryGrip(p, name, keys) {
  const grip = p.page.getByRole("separator", { name, exact: true }).first();
  if (!(await grip.count())) return false;
  await grip.focus();
  const a = await gripFacts(grip);
  for (const k of keys) await p.page.keyboard.press(k);
  await p.quiet();
  const b = await gripFacts(grip);
  const d = `${name}: ${a.now} -> ${b.now} (drawn ${a.drawn} -> ${b.drawn}), range ${b.min}..${b.max}`;
  await p.expect(b.now !== a.now && b.drawn !== a.drawn, `${keys[0]} on "${name}" changes the width`, { severity: "medium", detail: d });
  await p.expect(b.drawn === null || Math.abs(b.now - b.drawn) <= 4, `"${name}" reports the width that is drawn`, { severity: "low", detail: d });
  await p.expect(b.focused, `focus stays on "${name}" while resizing`, { severity: "low", detail: d });
  await p.page.keyboard.press("End");
  await p.quiet();
  const c = await gripFacts(grip);
  const vw = p.page.viewportSize().width;
  await p.expect(c.now === c.max && (c.right === null || c.right <= vw + 1), `End makes "${name}" widest, still on screen`, { severity: "low", detail: `now ${c.now}, max ${c.max}, right edge ${c.right} of ${vw}` });
  await p.page.keyboard.press("Home");
  await p.quiet();
  const h = await gripFacts(grip);
  await p.expect(h.now === h.min, `Home makes "${name}" narrowest`, { severity: "low", detail: `now ${h.now}, min ${h.min}` });
  return true;
}

async function resizeGrips(p) {
  const g = await openGraph(p);
  await expandLegend(p);
  const legend = await tryGrip(p, "Resize filters", ["ArrowRight", "ArrowRight"]);
  const n = await pickNode(p.page, g);
  if (n) await clickNode(p, n);
  const panel = n && (await tryGrip(p, "Resize panel", ["ArrowLeft", "ArrowLeft"]));
  if (!legend && !panel) skip("no resize grips");
}

async function findPage(p) {
  const g = await openGraph(p);
  // A text field with a suggestion list is a combobox to the accessibility tree, not a textbox.
  const input = p.page.getByLabel("Find a page on the map", { exact: true }).first();
  if (!(await input.count())) skip('no "Find a page" field');
  const sorted = [...g.nodes].sort((a, b) => a.degree - b.degree);
  const target = sorted[Math.floor(sorted.length / 3)] ?? sorted[0];
  await assertSafe(input, "type");
  await input.fill(target.label);
  await input.press("Enter");
  await p.quiet();
  await p.page.waitForTimeout(900);
  const panel = await readPanel(p.page);
  await p.expect(panel && sameTitle(panel.title, target.label), "Find a page opens the page it names", { detail: `typed "${target.label}"; panel: ${panel ? `"${panel.title}"` : "none"}` });
  await p.expect(panel?.focusInside, "the found page's panel takes the keyboard", { severity: "medium", detail: `focus on ${await focusedName(p.page)}` });
  const now = (await readGraph(p.page))?.nodes.find((x) => x.id === target.id);
  const onCanvas = now && (await p.page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.tagName === "CANVAS", [now.sx, now.sy]));
  await p.expect(onCanvas, "the map moves the found page into view, clear of the panels", { severity: "medium", detail: now ? `dot at ${Math.round(now.sx)},${Math.round(now.sy)}` : "page not on the map" });
}

export const GRAPH_PROBES = { hover, "click-and-escape": clickAndEscape, "focus-and-back": focusAndBack, "zoom-during-fit": zoomDuringFit,
  "filter-hides-selection": filterHidesSelection, "resize-grips": resizeGrips, "find-a-page": findPage };

export async function runGraphProbes(store, session, base) {
  for (const [name, fn] of Object.entries(GRAPH_PROBES)) await runProbe(store, session, base, `graph/${name}`, ROUTE, fn);
}
