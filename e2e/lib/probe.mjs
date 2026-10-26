// Interaction probes: a named sequence of actions, each followed by a check of
// what should now be true and a screenshot of the state. A check that fails
// becomes a finding; a probe whose controls are missing (older app code, an
// empty wiki) is recorded as skipped, not failed.
import { eventFindings } from "./collect.mjs";
import { waitForQuiet } from "./quiet.mjs";
import { SafetyRefusal } from "./safety.mjs";
import { stateShot } from "./store.mjs";

export class ProbeSkip extends Error {}
export const skip = (why) => { throw new ProbeSkip(why); };

export function createProbe(store, session, base, name, route) {
  const { page, tracker, vp } = session;
  const log = (entry) => store.probeLog.push({ probe: name, route, width: vp.width, url: page.url(), ...entry });
  const p = {
    name, page, session, base,
    quiet: () => waitForQuiet(page, tracker, { timeout: 8000 }),
    /** Screenshot the current state, labelled with the step. */
    async shot(step) { return stateShot(page, store, `probe-${name}-${step}`); },
    /** One check: logged with a screenshot; a false one becomes a finding. */
    async expect(ok, step, { severity = "high", detail = "", title } = {}) {
      const shot = await p.shot(step);
      log({ step, ok: !!ok, screenshot: shot, detail });
      if (!ok) {
        store.add({ route, width: vp.width, url: page.url(), severity, kind: "probe", screenshot: shot,
          title: `${name}: ${title ?? step}`, detail });
      }
      return !!ok;
    },
    /** A state worth seeing, with no pass/fail. */
    async note(step, detail = "") { log({ step, ok: null, screenshot: await p.shot(step), detail }); },
  };
  return p;
}

/** Runs one probe function, turning skips, refusals and crashes into log entries. */
export async function runProbe(store, session, base, name, route, fn) {
  const probe = createProbe(store, session, base, name, route);
  session.collectors.reset();
  const t0 = Date.now();
  try {
    await fn(probe);
    console.log(`  probe ${name}: done in ${Date.now() - t0} ms`);
  } catch (e) {
    const shot = await probe.shot("stopped").catch(() => null);
    if (e instanceof ProbeSkip) {
      store.probeLog.push({ probe: name, route, width: session.vp.width, step: "skipped", ok: null, detail: e.message, screenshot: shot });
      console.log(`  probe ${name}: skipped (${e.message})`);
    } else if (e instanceof SafetyRefusal) {
      store.probeLog.push({ probe: name, route, width: session.vp.width, step: "refused by the guard", ok: null, detail: e.message, screenshot: shot });
      console.log(`  probe ${name}: refused (${e.message})`);
    } else {
      store.probeLog.push({ probe: name, route, width: session.vp.width, step: "crashed", ok: false, detail: e.stack?.split("\n").slice(0, 4).join("\n"), screenshot: shot });
      store.add({ route, width: session.vp.width, url: session.page.url(), severity: "info", kind: "harness", screenshot: shot,
        title: `Probe ${name} stopped: ${e.message.split("\n")[0].slice(0, 140)}` });
      console.log(`  probe ${name}: crashed (${e.message.split("\n")[0]})`);
    }
  }
  // Errors the page logged while the probe drove it are findings too, tagged with the probe.
  const where = { route, width: session.vp.width, url: session.page.url() };
  for (const f of eventFindings(session.collectors.drain(), where)) {
    store.add({ ...f, detail: `${f.detail ?? ""}\n(during probe "${name}")`.trim() });
  }
}
