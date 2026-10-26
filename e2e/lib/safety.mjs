// Read-only guard rails. Two layers:
//  1. A click/press denylist: anything whose name, text or role says it changes
//     data (delete, compile, save, import, ...) is refused before it is touched.
//  2. A network guard on the browser context: every request that is not a read
//     (POST/PUT/PATCH/DELETE, or a GET that downloads an export) is aborted and
//     logged, whatever the page tried to do.
// Neither layer can be turned off from the command line.

/** Words that mark a control as one that writes, spends or downloads. */
export const DENY_WORDS = [
  "delete", "archive", "unarchive", "remove", "reset", "wipe", "clear", "purge", "erase",
  "compile", "recompile", "retry", "approve", "reject", "restore", "rebuild", "build",
  "add", "save", "import", "export", "download", "upload", "ingest", "finalize", "submit",
  "start", "stop", "cancel", "confirm", "discard", "run", "send", "apply", "upgrade",
  "backfill", "cleanup", "clean up", "enable", "disable", "turn on", "turn off",
  "sign out", "log out", "dismiss all", "regenerate", "generate", "lint",
];
const DENY_RE = new RegExp(`\\b(${DENY_WORDS.map((w) => w.replace(/ /g, "\\s+")).join("|")})\\b`, "i");

/** Read-only controls whose names happen to contain a denied word. */
export const ALLOW_NAMES = [
  /^connect two pages$/i, /^close path finder$/i, /^show all\b/i, /^show fewer$/i,
  /^find a page( on the map)?$/i, /^why[: ]/i, /^see in graph$/i,
];

/** API paths a GET may not reach either: they download files. */
export const DENY_GET = [/\/api\/export(\/|\?|$)/i, /[?&]download=/i];
const READ_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

/** Every refusal and network block, in order, for the report. */
export const safetyLog = [];

export function logSafety(entry) {
  const e = { at: new Date().toISOString(), ...entry };
  safetyLog.push(e);
  console.log(`  [guard] ${e.type}: ${e.method ? `${e.method} ` : ""}${e.url ?? e.target ?? ""}${e.reason ? ` (${e.reason})` : ""}`);
  return e;
}

/** Whether a request must be blocked; returns the reason or null. */
export function blockReason(method, url) {
  if (!READ_METHODS.has(method)) return `${method} is a write`;
  if (DENY_GET.some((re) => re.test(url))) return "download/export";
  return null;
}

/**
 * Installs the network guard on a browser context. Blocked requests are aborted
 * with "blockedbyclient" and remembered so the collectors do not report them as
 * failures. Returns the set of blocked request URLs (method + url keys).
 */
export async function installNetworkGuard(context, { onBlock } = {}) {
  const blocked = new Set();
  await context.route("**/*", async (route) => {
    const req = route.request();
    const reason = blockReason(req.method(), req.url());
    if (!reason) return route.fallback();
    blocked.add(`${req.method()} ${req.url()}`);
    const entry = logSafety({ type: "network-block", method: req.method(), url: req.url(), reason, page: safePageUrl(req) });
    onBlock?.(entry);
    return route.abort("blockedbyclient");
  });
  return blocked;
}

function safePageUrl(req) {
  try { return req.frame().url(); } catch { return null; }
}

/** Confirm/prompt dialogs are dismissed (the safe answer); alerts are accepted. */
export function attachDialogGuard(page) {
  page.on("dialog", async (d) => {
    logSafety({ type: "dialog", target: d.message().slice(0, 160), reason: `${d.type()} dismissed` });
    if (d.type() === "alert") await d.accept().catch(() => {});
    else await d.dismiss().catch(() => {});
  });
}

/** Runs in the page: what a control is, for the denylist check. */
export function describeInPage(el) {
  const text = (s) => (s ?? "").replace(/\s+/g, " ").trim();
  const ctl = el.closest("a,button,input,select,textarea,summary,label,[role],[tabindex]") ?? el;
  const form = ctl.closest("form");
  const type = (ctl.getAttribute("type") ?? "").toLowerCase();
  const tag = ctl.tagName.toLowerCase();
  const isSubmit = tag === "button" ? (type === "" || type === "submit") && !!form : tag === "input" && ["submit", "image"].includes(type);
  return {
    tag,
    role: ctl.getAttribute("role") ?? "",
    name: text(ctl.getAttribute("aria-label") || ctl.getAttribute("title") || ctl.textContent).slice(0, 120),
    text: text(ctl.textContent).slice(0, 120),
    title: text(ctl.getAttribute("title")),
    href: ctl.getAttribute("href") ?? "",
    download: ctl.hasAttribute("download"),
    type,
    isSubmit,
    formMethod: form ? (form.getAttribute("method") ?? "get").toLowerCase() : null,
    pressed: ctl.getAttribute("aria-pressed"),
    switchLike: ctl.getAttribute("role") === "switch" || type === "checkbox" || type === "radio" || tag === "select",
    path: location.pathname,
  };
}

/** The reason a described control must not be clicked, or null when it is safe. */
export function refusalFor(d) {
  const names = [d.name, d.text, d.title].filter(Boolean);
  const allowed = names.some((n) => ALLOW_NAMES.some((re) => re.test(n)));
  if (d.type === "file") return "file picker";
  if (d.download) return "download link";
  if (d.tag === "a" && d.href.startsWith("#")) return null; // a jump within the page ("Backup & restore" in Settings' contents)
  if (/\/api\//.test(d.href)) return `link into the API (${d.href})`;
  if (d.isSubmit && d.formMethod !== "get") return "submits a form";
  if (d.path.startsWith("/settings") && (d.switchLike || d.pressed !== null)) return "settings controls save at once";
  if (d.path.startsWith("/onboarding") && (d.isSubmit || /continue|next|build/i.test(d.name))) return "onboarding step that saves";
  if (!allowed) for (const n of names) {
    const m = n.match(DENY_RE);
    if (m) return `denylisted word "${m[1].toLowerCase()}"`;
  }
  return null;
}

export class SafetyRefusal extends Error {
  constructor(reason, target) {
    super(`refused: ${reason}`);
    this.reason = reason;
    this.target = target;
  }
}

/** Checks a locator's element against the denylist; throws SafetyRefusal when denied. */
export async function assertSafe(locator, what = "click") {
  const d = await locator.evaluate(describeInPage);
  const reason = refusalFor(d);
  if (reason) {
    logSafety({ type: "refused", target: `${d.tag}${d.role ? `[${d.role}]` : ""} "${d.name}"`, reason: `${what}: ${reason}` });
    throw new SafetyRefusal(reason, d);
  }
  return d;
}

/** Click only after the denylist check. */
export async function safeClick(locator, opts = {}) {
  await assertSafe(locator, "click");
  await locator.click(opts);
}

/** The element at a viewport point, checked before a raw mouse click there. */
export async function assertSafePoint(page, x, y) {
  const d = await page.evaluate(([x, y]) => {
    const el = document.elementFromPoint(x, y);
    return el ? window.__e2eDescribe?.(el) ?? null : null;
  }, [x, y]);
  const reason = d ? refusalFor(d) : null;
  if (reason) {
    logSafety({ type: "refused", target: `point ${x},${y} "${d.name}"`, reason: `click: ${reason}` });
    throw new SafetyRefusal(reason, d);
  }
  return d;
}

/** Init script: exposes describeInPage as window.__e2eDescribe for point checks. */
export const DESCRIBE_INIT = `window.__e2eDescribe = ${describeInPage.toString()};`;
