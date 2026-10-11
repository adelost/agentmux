// Which processes are this agentmux stack's bridge and start.sh supervisors.
//
// A working directory proves nothing: the bridge moves to the home directory
// when it starts (bin/runtime-env-bootstrap.mjs), and `npm install --global`
// renames the package directory start.sh stands in to .agentmux-XXXX and
// deletes it. A stack is its HOME, where ~/.agentmux keeps its heartbeat, so a
// process with another HOME (a test's, say) is not this stack's.
// bin/bridge-watchdog-cron.sh and bin/bridge-rescue.sh apply the same rules.

import { readFileSync, readdirSync, readlinkSync } from "node:fs";
import { homedir } from "node:os";

const BRIDGE_COMMAND = /\bnode\b.*\bindex\.mjs\b/u;
const SUPERVISOR_COMMAND = /\bbin\/start\.sh\b/u;
const PACKAGE_DIR = /\/agentmux(?: \(deleted\))?$|\/\.agentmux-[^/]+ \(deleted\)$/u;

/** WHAT: Tells whether a working directory is an agentmux package, as installed or after an install replaced it. WHY: start.sh keeps standing in the replaced one. */
export function isAgentmuxPackageDir(path) {
  return PACKAGE_DIR.test(String(path || ""));
}

/** WHAT: Reads the process facts identity needs from /proc. WHY: One reader for every caller; tests pass their own. */
export function procReader(root = "/proc") {
  const read = (pid, name) => { try { return readFileSync(`${root}/${pid}/${name}`, "utf8"); } catch { return ""; } };
  return {
    pids: () => { try { return readdirSync(root).filter((name) => /^\d+$/u.test(name)).map(Number); } catch { return []; } },
    cmdline: (pid) => read(pid, "cmdline").split("\0").join(" ").trim(),
    cwd: (pid) => { try { return readlinkSync(`${root}/${pid}/cwd`); } catch { return ""; } },
    ppid: (pid) => Number(read(pid, "stat").replace(/^.*\)\s+\S+\s+/su, "").split(" ")[0]) || null,
    uid: (pid) => Number(/^Uid:\s+(\d+)/mu.exec(read(pid, "status"))?.[1] ?? Number.NaN),
    home: (pid) => read(pid, "environ").split("\0").find((entry) => entry.startsWith("HOME="))?.slice(5) ?? null,
  };
}

/**
 * WHAT: Finds this stack's bridges and supervisors.
 * WHY: A bridge is the pid its own heartbeat names or a child of an agentmux supervisor; both hold after an install and after the bridge moved home.
 */
export function findBridgeStack({ beat = null, proc = procReader(), uid = process.getuid(), home = homedir() } = {}) {
  const ours = (pid) => proc.uid(pid) === uid && proc.home(pid) === home;
  const candidates = proc.pids().map((pid) => ({ pid, command: proc.cmdline(pid) }));
  const supervisors = candidates
    .filter(({ pid, command }) => SUPERVISOR_COMMAND.test(command) && isAgentmuxPackageDir(proc.cwd(pid)) && ours(pid))
    .map(({ pid }) => pid);
  const beatPid = Number(beat?.pid) || null;
  const bridges = candidates
    .filter(({ pid, command }) => BRIDGE_COMMAND.test(command) && ours(pid)
      && (pid === beatPid || supervisors.includes(proc.ppid(pid))))
    .map(({ pid }) => pid);
  return { bridges, supervisors };
}
