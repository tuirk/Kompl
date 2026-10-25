// findings.json and a static index.html next to it: findings grouped by
// severity, each with its screenshot, then the probe steps, the counts each
// screen states, the guard's log and every visit.
import fs from "node:fs";
import path from "node:path";
import { SEVERITIES } from "./store.mjs";

const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
const where = (o) => `${o.route} @${o.width}`;

export function writeReport(store, meta) {
  const findings = store.list();
  const json = { ...meta, findings, probes: store.probeLog, counts: store.counts, guard: store.guardLog, visits: store.visits };
  fs.writeFileSync(path.join(store.outDir, "findings.json"), JSON.stringify(json, null, 1));
  fs.writeFileSync(path.join(store.outDir, "index.html"), html(json));
  return json;
}

function shot(rel, alt) {
  return rel ? `<a href="${esc(rel)}" target="_blank"><img loading="lazy" src="${esc(rel)}" alt="${esc(alt)}"></a>` : `<div class="noshot">no screenshot</div>`;
}

function findingCard(f) {
  const places = f.occurrences.slice(0, 12).map((o) => `<li>${o.screenshot ? `<a href="${esc(o.screenshot)}" target="_blank">${esc(where(o))}</a>` : esc(where(o))}</li>`).join("");
  const more = f.occurrences.length > 12 || f.more ? `<li>… ${f.occurrences.length - 12 + (f.more ?? 0)} more</li>` : "";
  return `<article class="f ${f.severity}" id="${f.id}">
  <div class="txt">
    <div class="meta"><span class="sev">${f.severity}</span> <span class="kind">${esc(f.kind)}</span> <span class="id">${f.id}</span> · seen ${f.occurrences.length + (f.more ?? 0)}×</div>
    <h3>${esc(f.title)}</h3>
    ${f.detail ? `<pre>${esc(f.detail)}</pre>` : ""}
    <ul class="places">${places}${more}</ul>
  </div>
  <div class="pic">${shot(f.screenshot, f.title)}</div>
</article>`;
}

function probeRows(probes) {
  return probes.map((p) => `<tr class="${p.ok === false ? "bad" : p.ok ? "ok" : "na"}"><td>${esc(p.probe)}</td><td>${esc(p.step)}</td>
<td>${p.ok === null ? "–" : p.ok ? "pass" : "FAIL"}</td><td><pre>${esc(p.detail ?? "")}</pre></td><td>${p.screenshot ? `<a href="${esc(p.screenshot)}" target="_blank">shot</a>` : ""}</td></tr>`).join("");
}

function html(r) {
  const bySev = Object.fromEntries(SEVERITIES.map((s) => [s, r.findings.filter((f) => f.severity === s)]));
  const summary = SEVERITIES.map((s) => `<a class="chip ${s}" href="#sev-${s}">${s} <b>${bySev[s].length}</b></a>`).join(" ");
  const sections = SEVERITIES.filter((s) => bySev[s].length).map((s) => `<h2 id="sev-${s}">${s} (${bySev[s].length})</h2>${bySev[s].map(findingCard).join("\n")}`).join("\n");
  const counts = Object.entries(r.counts ?? {}).map(([route, list]) => `<tr><td>${esc(route)}</td><td>${esc(list.map((c) => c.text).join(", "))}</td></tr>`).join("");
  const guard = (r.guard ?? []).map((g) => `<tr><td>${esc(g.type)}</td><td>${esc(g.method ?? "")} ${esc(g.url ?? g.target ?? "")}</td><td>${esc(g.reason ?? "")}</td><td>${esc(g.page ?? "")}</td></tr>`).join("");
  const visits = r.visits.map((v) => `<tr><td>${esc(v.route)}</td><td>${v.width}</td><td>${v.status ?? ""}${v.error ? ` ${esc(v.error)}` : ""}</td><td>${v.loadMs ?? ""}</td>
<td>${v.finalUrl && !v.finalUrl.endsWith(v.route) ? esc(new URL(v.finalUrl).pathname) : ""}</td><td>${v.findings ?? 0}</td><td>${v.screenshot ? `<a href="${esc(v.screenshot)}" target="_blank">shot</a>` : ""}</td></tr>`).join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Kompl crawl ${esc(r.run)}</title><style>
:root{--bg:#f6f7f8;--card:#fff;--fg:#1b1d20;--dim:#5d636b;--line:#dde1e5;--critical:#b3001b;--high:#d9480f;--medium:#b07d00;--low:#2b6cb0;--info:#6b7280}
@media (prefers-color-scheme:dark){:root{--bg:#121316;--card:#1c1e22;--fg:#e8eaed;--dim:#9aa0a6;--line:#2e3136}}
body{margin:0;padding:16px;background:var(--bg);color:var(--fg);font:14px/1.45 system-ui,sans-serif}
h1{font-size:20px;margin:0 0 4px}h2{margin:28px 0 10px;font-size:17px;text-transform:capitalize}
.chip{display:inline-block;padding:3px 10px;border-radius:999px;border:1px solid var(--line);color:var(--fg);text-decoration:none;margin:2px}
.chip.critical,.f.critical .sev{color:var(--critical)}.chip.high,.f.high .sev{color:var(--high)}.chip.medium,.f.medium .sev{color:var(--medium)}.chip.low,.f.low .sev{color:var(--low)}.chip.info,.f.info .sev{color:var(--info)}
.f{display:grid;grid-template-columns:minmax(0,1fr) minmax(0,420px);gap:14px;background:var(--card);border:1px solid var(--line);border-left:4px solid var(--line);border-radius:8px;padding:12px;margin:10px 0}
.f.critical{border-left-color:var(--critical)}.f.high{border-left-color:var(--high)}.f.medium{border-left-color:var(--medium)}.f.low{border-left-color:var(--low)}
.f h3{margin:4px 0 6px;font-size:15px;overflow-wrap:anywhere}.meta{color:var(--dim);font-size:12px}.sev{font-weight:700;text-transform:uppercase}
pre{white-space:pre-wrap;overflow-wrap:anywhere;background:rgba(127,127,127,.08);padding:8px;border-radius:6px;font-size:12px;margin:6px 0;max-height:220px;overflow:auto}
.places{margin:4px 0 0;padding-left:18px;color:var(--dim);font-size:12px;columns:2}
.pic img{width:100%;max-height:300px;object-fit:cover;object-position:top;border:1px solid var(--line);border-radius:6px}
table{border-collapse:collapse;width:100%;background:var(--card);font-size:12px}td,th{border-bottom:1px solid var(--line);padding:4px 6px;text-align:left;vertical-align:top}
tr.bad td{color:var(--critical)}td pre{max-height:90px;margin:0}a{color:var(--low)}
.wrap{overflow-x:auto}.noshot{color:var(--dim);font-size:12px}
@media (max-width:720px){.f{grid-template-columns:1fr}.places{columns:1}}
</style></head><body>
<h1>Kompl crawl ${esc(r.run)}</h1>
<div class="meta">${esc(r.base)} · ${esc(r.startedAt)} → ${esc(r.finishedAt)} · ${r.routes} routes × ${r.viewports.join(", ")} px · ${r.visits.length} visits · route cap ${r.maxRoutes}${r.dropped ? `, ${r.dropped} links over the cap` : ""}</div>
<p>${summary}</p>
<p class="meta">Findings are leads: each groups one problem across every place it was seen, with the first screenshot. Read the screenshot before acting.</p>
${sections || "<p>No findings.</p>"}
<h2 id="probes">Interaction probes</h2><div class="wrap"><table><tr><th>probe</th><th>step</th><th>result</th><th>detail</th><th></th></tr>${probeRows(r.probes ?? [])}</table></div>
<h2 id="counts">Counts each screen states</h2><p class="meta">From the APIs: ${esc(JSON.stringify(r.truth ?? {}))}</p>
<div class="wrap"><table><tr><th>screen</th><th>counts shown</th></tr>${counts}</table></div>
<h2 id="guard">Guard log (blocked requests, refused controls, dialogs)</h2><div class="wrap"><table><tr><th>type</th><th>what</th><th>why</th><th>page</th></tr>${guard || "<tr><td colspan=4>nothing blocked</td></tr>"}</table></div>
<h2 id="visits">Visits</h2><div class="wrap"><table><tr><th>route</th><th>width</th><th>status</th><th>ms to quiet</th><th>landed on</th><th>findings</th><th></th></tr>${visits}</table></div>
</body></html>`;
}
