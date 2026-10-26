// The explorer's browser keeper, started by `explore-step start` and left
// running: a guarded Playwright browser at one viewport, and a small HTTP
// server on 127.0.0.1 that runs one step per request. Keeping the browser in
// one process keeps the page, its listeners and the network guard alive
// between steps (a panel opened in one step is still open in the next).
// It exits on `stop`, or after EXPLORE_IDLE_MS without a step.
//   node lib/explore-daemon.mjs --dir <session dir> --base <url> --width 1280 --height 800
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { launchBrowser, openSession } from "./browser.mjs";
import { eventFindings } from "./collect.mjs";
import { checkBase, parseArgs, slug } from "./config.mjs";
import { act, explainActionError } from "./explore-actions.mjs";
import { focusedName } from "./graph-util.mjs";
import { waitForQuiet } from "./quiet.mjs";
import { SafetyRefusal } from "./safety.mjs";

/** The browser closes itself after this long with no step. */
export const EXPLORE_IDLE_MS = 2 * 60 * 60 * 1000;

const args = parseArgs(process.argv.slice(2));
const dir = path.resolve(String(args.dir));
const base = checkBase(args.base);
const vp = { name: "explore", width: Number(args.width ?? 1280), height: Number(args.height ?? 800) };
const blocks = [];
const browser = await launchBrowser();
const session = await openSession(browser, vp, base, { onBlock: (e) => blocks.push(e) });
const { page, tracker, collectors } = session;
page.setDefaultNavigationTimeout(45000);
page.setDefaultTimeout(15000);
let step = Number(args.step ?? 0);
let lastUsed = Date.now();
let busy = false;

/** Waits for quiet, then writes NN-<action>.png / .aria.yml / .log.txt; returns the printed lines. */
async function capture(action, extra) {
  const quiet = await waitForQuiet(page, tracker);
  const n = String(step).padStart(2, "0");
  const stem = path.join(dir, `${n}-${slug(action).slice(0, 40)}`);
  await page.screenshot({ path: `${stem}.png`, fullPage: !!extra.fullPage }).catch(() => {});
  const aria = await page.locator("body").ariaSnapshot({ timeout: 10000 }).catch((e) => `(no snapshot: ${e.message.split("\n")[0]})`);
  fs.writeFileSync(`${stem}.aria.yml`, aria);
  const events = collectors.drain();
  const where = { route: new URL(page.url()).pathname, width: vp.width, url: page.url() };
  const problems = eventFindings(events, where).map((f) => `[${f.severity}] ${f.title}`);
  const blocked = blocks.splice(0);
  const size = page.viewportSize();
  const lines = [
    `step ${n}: ${action}`, `url: ${page.url()}`, `title: ${await page.title().catch(() => "")}`, `viewport: ${size?.width}x${size?.height}`,
    `quiet: ${quiet.quiet ? `yes, after ${quiet.ms} ms` : `NO (${quiet.why} still changing after ${quiet.ms} ms)`}`,
    `focus: ${await focusedName(page)}`, ...(extra.note ? [`note: ${extra.note}`] : []), ...(extra.error ? [`STEP FAILED: ${extra.error}`] : []),
    `console/network problems since the last step: ${problems.length}`, ...problems.map((p) => `  ${p}`),
    `blocked by the guard: ${blocked.length}`, ...blocked.map((b) => `  ${b.method} ${b.url} (${b.reason})`),
  ];
  const consoleLines = events.filter((e) => e.type === "console").map((e) => `  ${e.level}: ${e.text}`);
  fs.writeFileSync(`${stem}.log.txt`, [...lines, "console messages:", ...consoleLines].join("\n") + "\n");
  return [...lines, "files:", `  ${stem}.png`, `  ${stem}.aria.yml`, `  ${stem}.log.txt`];
}

async function runStep(body) {
  lastUsed = Date.now();
  const label = [body.action, body.a1, body.a2].filter((x) => x !== undefined && x !== null).join(" ");
  if (body.action !== "nodes") step++;
  let extra = {};
  try {
    extra = await act(page, base, body);
  } catch (e) {
    if (e instanceof SafetyRefusal) { step--; return { code: 2, lines: [`REFUSED: ${e.message}. The guard keeps the exploration read-only; pick another step.`] }; }
    extra = { error: explainActionError(e) };
  }
  if (extra.noCapture) return { code: 0, lines: [extra.listing] };
  const lines = await capture(label, extra);
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ ...readState(), step }, null, 1));
  return { code: extra.error ? 1 : 0, lines };
}

function readState() {
  try { return JSON.parse(fs.readFileSync(path.join(dir, "state.json"), "utf8")); } catch { return {}; }
}

async function shutdown() {
  await browser.close().catch(() => {});
  fs.rmSync(path.join(dir, "state.json"), { force: true });
  process.exit(0);
}

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => { raw += c; });
  req.on("end", async () => {
    const reply = (code, obj) => { res.writeHead(code, { "content-type": "application/json" }); res.end(JSON.stringify(obj)); };
    if (req.url === "/ping") return reply(200, { ok: true, step });
    if (req.url === "/stop") { reply(200, { code: 0, lines: ["stopped"] }); return setTimeout(shutdown, 50); }
    if (req.url !== "/step") return reply(404, { code: 1, lines: ["unknown request"] });
    if (busy) return reply(409, { code: 1, lines: ["another step is still running"] });
    busy = true;
    try { reply(200, await runStep(JSON.parse(raw || "{}"))); }
    catch (e) { reply(500, { code: 1, lines: [`daemon error: ${e.message.split("\n")[0]}`] }); }
    finally { busy = false; }
  });
});
server.listen(0, "127.0.0.1", () => {
  const { port } = server.address();
  fs.writeFileSync(path.join(dir, "state.json"), JSON.stringify({ base, port, pid: process.pid, width: vp.width, height: vp.height, step, startedAt: new Date().toISOString() }, null, 1));
  console.log(`explore daemon on 127.0.0.1:${port} for ${base}`);
});
setInterval(() => { if (!busy && Date.now() - lastUsed > EXPLORE_IDLE_MS) shutdown(); }, 60000).unref();
