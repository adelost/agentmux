import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";

/** WHAT: Names the shared model-owner lease. WHY: Prevents releases or alternate indexes from loading native models beside an existing owner. */
export const embedderLeasePath = () => join(process.env.HOME, ".agentmux", "search-embedder.lock");

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

/** WHAT: Tracks one idle deadline across concurrent model requests. WHY: Prevents health pings or a second completion from closing an active query's listener. */
export function createEmbedderIdle({ idleMs, busy = () => false, close }) {
  let active = 0, timer = null;
  const cancel = () => { clearTimeout(timer); timer = null; };
  const check = () => {
    if (active) return;
    if (busy()) { timer = setTimeout(check, Math.min(idleMs, 1000)); return; }
    close();
  };
  const arm = () => { cancel(); if (!active) timer = setTimeout(check, idleMs); };
  return {
    arm, cancel,
    begin() { active++; cancel(); },
    finish() { active--; if (!active) arm(); },
  };
}
