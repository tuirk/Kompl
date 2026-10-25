// Target syntax for explore-step: how a step names what it acts on.
//   role:<role>:<name>   getByRole with that exact accessible name (role:button:Zoom in)
//   role:<role>          the first element with that role
//   text:<text>          getByText, exact first, then containing
//   label:<text>         getByLabel (form fields, aria-label)
//   placeholder:<text>   getByPlaceholder
//   css:<selector>       a CSS selector
//   node:<title or id>   a page dot on the topic map (/wiki/graph)
//   xy:<x>,<y>           a point in the viewport (CSS px)
// Add @<n> to pick the n-th match (0-based): text:Show all@1
import { readGraph } from "./graph-util.mjs";

export function parseTarget(raw) {
  if (!raw) throw new Error("this action needs a target, e.g. role:button:Zoom in");
  let spec = String(raw), nth = null;
  const at = spec.match(/@(\d+)$/);
  if (at) { nth = Number(at[1]); spec = spec.slice(0, -at[0].length); }
  const i = spec.indexOf(":");
  if (i < 0) return { kind: "text", value: spec, nth };
  const kind = spec.slice(0, i);
  const value = spec.slice(i + 1);
  if (!["role", "text", "label", "placeholder", "css", "node", "xy"].includes(kind)) return { kind: "text", value: spec, nth };
  return { kind, value, nth };
}

/**
 * Resolves a target to { locator } or { point: {x, y} }, with a note when the
 * choice was ambiguous. Throws when nothing matches.
 */
export async function resolveTarget(page, t) {
  if (t.kind === "xy") {
    const [x, y] = t.value.split(",").map(Number);
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error(`xy needs two numbers: ${t.value}`);
    return { point: { x, y }, note: "" };
  }
  if (t.kind === "node") {
    const g = await readGraph(page);
    if (!g?.nodes.length) throw new Error("no topic map on this screen (node: works on /wiki/graph)");
    const want = t.value.trim().toLowerCase();
    const n = g.nodes.find((x) => x.id === t.value) ?? g.nodes.find((x) => x.label.toLowerCase() === want)
      ?? g.nodes.find((x) => x.label.toLowerCase().includes(want));
    if (!n) throw new Error(`no page "${t.value}" on the map; run the "nodes" action for the list`);
    const vp = page.viewportSize() ?? (await page.evaluate(() => ({ width: innerWidth, height: innerHeight })));
    const inView = n.sx >= 0 && n.sy >= 0 && n.sx <= vp.width && n.sy <= vp.height;
    return { point: { x: n.sx, y: n.sy }, note: `page "${n.label}" at ${Math.round(n.sx)},${Math.round(n.sy)}${inView ? "" : " (off screen)"}` };
  }
  let loc;
  if (t.kind === "role") {
    const [role, ...rest] = t.value.split(":");
    const name = rest.join(":");
    loc = name ? page.getByRole(role, { name, exact: true }) : page.getByRole(role);
    if (name && !(await loc.count())) loc = page.getByRole(role, { name });
  } else if (t.kind === "text") {
    loc = page.getByText(t.value, { exact: true });
    if (!(await loc.count())) loc = page.getByText(t.value);
  } else if (t.kind === "label") loc = page.getByLabel(t.value);
  else if (t.kind === "placeholder") loc = page.getByPlaceholder(t.value);
  else loc = page.locator(t.value);
  const count = await loc.count();
  if (!count) throw new Error(`nothing matches ${t.kind}:${t.value}`);
  const idx = t.nth ?? 0;
  if (idx >= count) throw new Error(`${t.kind}:${t.value} has ${count} matches; @${idx} is out of range`);
  const note = count > 1 && t.nth === null ? `${count} matches; used the first (add @n to pick another)` : "";
  return { locator: loc.nth(idx), note };
}
