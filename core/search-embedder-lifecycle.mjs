import { mkdirSync, openSync, readFileSync, readdirSync, renameSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

/** WHAT: Names the shared model-owner lease. WHY: Prevents releases or alternate indexes from loading native models beside an existing owner. */
export const embedderLeasePath = () => join(process.env.HOME, ".agentmux", "search-embedder.lock");

/** WHAT: Names the file that keeps the search daemon's stderr. WHY: Lets a reader find why the daemon failed or closed, such as under the memory floor. */
export const embedderLogPath = () => join(process.env.HOME, ".agentmux", "search-embedder.log");

const LOG_MAX_BYTES = 1024 * 1024;

/**
 * WHAT: Returns a descriptor for appending to the daemon's log.
 * WHY: Keeps the daemon's stderr, which `stdio: "ignore"` lost, without letting the log grow past 1 MiB.
 */
export function openEmbedderLog(path) {
  // A log over 1 MiB is renamed to <log>.1 first, replacing an older one. A new log gets mode 600.
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  try { if (statSync(path).size > LOG_MAX_BYTES) renameSync(path, `${path}.1`); }
  catch (error) { if (error.code !== "ENOENT") throw error; } // no log yet, or one that vanished: nothing to move aside
  return openSync(path, "a", 0o600);
}

/** The default is 30 minutes; AMUX_EMBEDDER_IDLE_MIN overrides it. WHAT: Returns how long the search daemon stays loaded after its last question. WHY: Keeps the model warm through a work session; AMUX_EMBEDDER_IDLE_MIN=2 restores the old two minutes. */
export const embedderIdleMs = (env = process.env) => Math.max(0.001, Number(env.AMUX_EMBEDDER_IDLE_MIN) || 30) * 60_000;

const DEFAULT_MIN_FREE_GB = 8;

/** The default is 8 GB; AMUX_EMBEDDER_MIN_FREE_GB overrides it and 0 turns the memory guard off. WHAT: Returns the free RAM, in GB, under which the search daemon closes. WHY: Keeps the daemon from holding RAM the machine needs elsewhere. */
export function embedderMinFreeGb(env = process.env) {
  const given = String(env.AMUX_EMBEDDER_MIN_FREE_GB ?? "").trim();
  const floor = given === "" ? NaN : Number(given);
  return Number.isFinite(floor) && floor >= 0 ? floor : DEFAULT_MIN_FREE_GB;
}

/** WHAT: Returns an older worker without the shared lease. WHY: Keeps an upgrade from duplicating a still-running pre-lease model. */
export function legacyEmbedderPid({ proc = "/proc", ownPid = process.pid, uid = process.getuid() } = {}) {
  for (const entry of readdirSync(proc).filter(name => /^\d+$/u.test(name))) {
    const pid = Number(entry);
    if (pid === ownPid) continue;
    try {
      if (statSync(join(proc, entry)).uid !== uid) continue;
      const args = readFileSync(join(proc, entry, "cmdline"), "utf8").split("\0");
      if (!args.some(arg => arg.endsWith("/bin/search-embedder.mjs")) || args.includes("--shared-owner-v1")) continue;
      const env = readFileSync(join(proc, entry, "environ"), "utf8").split("\0");
      if (env.includes(`HOME=${process.env.HOME}`)) return pid;
    } catch (error) {
      if (!["ENOENT", "ESRCH", "EACCES"].includes(error.code)) throw error;
    }
  }
  return null;
}

/** WHAT: Tracks the idle deadline and the single close across concurrent model requests. WHY: Prevents health pings or a second completion from closing an active query's listener. */
export function createEmbedderIdle({ idleMs, busy = () => false, close }) {
  // closeWhenQuiet is the memory guard's way out: the same close at the first moment no question is in flight. It does
  // not wait for background index work (`busy`), because that work is what holds the RAM being given back.
  let active = 0, timer = null, leaving = false, closed = false;
  const cancel = () => { clearTimeout(timer); timer = null; };
  const closeOnce = () => { if (closed) return; closed = true; cancel(); close(); };
  const check = () => {
    if (active) return;
    if (busy()) { timer = setTimeout(check, Math.min(idleMs, 1000)); return; }
    closeOnce();
  };
  const arm = () => { cancel(); if (!active) timer = setTimeout(check, idleMs); };
  return {
    arm, cancel,
    begin() { active++; cancel(); },
    finish() { active--; if (!active) leaving ? closeOnce() : arm(); },
    closeWhenQuiet() { leaving = true; if (!active) closeOnce(); },
  };
}
