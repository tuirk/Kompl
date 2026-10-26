// axe-core accessibility scan, serious and critical violations only.
import AxeBuilder from "@axe-core/playwright";
import { AXE_IMPACTS } from "./config.mjs";

export async function axeFindings(page, where) {
  let results;
  try {
    results = await new AxeBuilder({ page }).options({ resultTypes: ["violations"] }).analyze();
  } catch (e) {
    return [{ ...where, severity: "info", kind: "harness", title: `axe could not run: ${e.message.slice(0, 120)}` }];
  }
  const out = [];
  for (const v of results.violations) {
    if (!AXE_IMPACTS.includes(v.impact)) continue;
    const first = v.nodes[0];
    const target = Array.isArray(first?.target?.[0]) ? null : first?.target?.[0] ?? null;
    const nodes = v.nodes.slice(0, 6).map((n) => `- ${n.target.join(" ")}\n  ${(n.failureSummary ?? "").replace(/\n/g, "\n  ")}`).join("\n");
    out.push({
      ...where,
      severity: v.impact === "critical" ? "high" : "medium",
      kind: "axe",
      title: `a11y ${v.id}: ${v.help}`,
      groupBy: `axe ${v.id} ${target ?? ""}`,
      selector: typeof target === "string" ? target : null,
      detail: `${v.description}\n${v.nodes.length} element(s). ${v.helpUrl}\n${nodes}`,
    });
  }
  return out;
}
