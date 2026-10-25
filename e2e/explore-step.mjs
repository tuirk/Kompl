// One step of a guided, read-only exploration of Kompl (see EXPLORER.md).
//   npm run explore-step -- start [--base http://localhost:3000] [--width 1280] [--height 800] [--path /]
//   npm run explore-step -- goto /wiki/graph
//   npm run explore-step -- click "role:button:Zoom in"
//   npm run explore-step -- hover node:Vilnius
//   npm run explore-step -- press Escape            (press <key> [target])
//   npm run explore-step -- type "label:Find a page on the map" "Vilnius"
//   npm run explore-step -- scroll 600              (scroll <dy> [target])
//   npm run explore-step -- back | forward | reload | snap [--full]
//   npm run explore-step -- resize 1024 768
//   npm run explore-step -- nodes                   (page dots on the map, for node: targets)
//   npm run explore-step -- stop
// Targets: role:<role>:<name>, text:<text>, label:<text>, placeholder:<text>, css:<sel>, node:<page>, xy:<x>,<y>; add @n for the n-th match.
// Each step waits for quiet and writes NN-<action>.png, .aria.yml and .log.txt under out/explore/<session>/
// (--session <name>, default "default"). A browser stays open between steps (lib/explore-daemon.mjs).
// Exit codes: 0 done, 1 error (the state is still captured), 2 refused by the guard.
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { checkBase, E2E_DIR, parseArgs, routeArg, slug } from "./lib/config.mjs";

const args = parseArgs(process.argv.slice(2));
const [action, a1, a2] = args._;
const dir = path.join(E2E_DIR, "out", "explore", slug(String(args.session ?? "default")));
const stateFile = path.join(dir, "state.json");
const readState = () => { try { return JSON.parse(fs.readFileSync(stateFile, "utf8")); } catch { return null; } };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function call(state, what, body) {
  const res = await fetch(`http://127.0.0.1:${state.port}/${what}`, { method: "POST", body: JSON.stringify(body ?? {}) });
  return res.json();
}

async function alive(state) {
  if (!state) return false;
  try { return (await fetch(`http://127.0.0.1:${state.port}/ping`, { method: "POST" })).ok; } catch { return false; }
}

async function start() {
  const old = readState();
  if (await alive(old)) {
    if (!args.restart) { console.error(`session already running (step ${old.step}); add --restart, or stop it first`); return 1; }
    await call(old, "stop").catch(() => {});
    await sleep(500);
  }
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  const base = checkBase(args.base);
  const log = fs.openSync(path.join(dir, "daemon.log"), "a");
  const daemon = path.join(path.dirname(fileURLToPath(import.meta.url)), "lib", "explore-daemon.mjs");
  const child = spawn(process.execPath, [daemon, "--dir", dir, "--base", base, "--width", String(args.width ?? 1280), "--height", String(args.height ?? 800)],
    { detached: true, stdio: ["ignore", log, log], windowsHide: true });
  child.unref();
  for (let i = 0; i < 120; i++) {
    const s = readState();
    if (await alive(s)) return step(s, { action: "goto", a1: routeArg(args.path) });
    await sleep(250);
  }
  console.error(`the explorer's browser did not start; see ${path.join(dir, "daemon.log")}`);
  return 1;
}

async function step(state, body) {
  const out = await call(state, "step", body);
  (out.code === 0 ? console.log : console.error)(out.lines.join("\n"));
  return out.code;
}

async function main() {
  if (!action) {
    console.error("usage: npm run explore-step -- <start|goto|click|hover|press|type|scroll|back|forward|reload|resize|snap|nodes|stop> ...");
    return 1;
  }
  if (action === "start") return start();
  const state = readState();
  if (!(await alive(state))) { console.error('no explorer running: "npm run explore-step -- start" first'); return 1; }
  if (action === "stop") { await call(state, "stop"); console.log("stopped"); return 0; }
  return step(state, { action, a1: action === "goto" ? routeArg(a1) : a1, a2, full: !!args.full });
}

process.exitCode = await main();
