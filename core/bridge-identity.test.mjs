import { expect, feature, unit } from "bdd-vitest";
import { findBridgeStack, isAgentmuxPackageDir } from "./bridge-identity.mjs";

const HOME = "/home/u";
const PACKAGE = "/home/u/.nvm/versions/node/v22/lib/node_modules/agentmux";
const BRIDGE = "node --import ./bin/runtime-env-bootstrap.mjs --import ./bin/quota-recovery-bootstrap.mjs index.mjs";

// Live processes by pid; a pid missing here has exited.
function procOf(processes) {
  const at = (pid) => processes[pid] || {};
  return {
    pids: () => Object.keys(processes).map(Number),
    cmdline: (pid) => at(pid).cmdline || "",
    cwd: (pid) => at(pid).cwd || "",
    ppid: (pid) => at(pid).ppid ?? null,
    uid: (pid) => at(pid).uid ?? 1000,
    home: (pid) => at(pid).home ?? HOME,
  };
}

const stack = (processes, beat) => findBridgeStack({ beat, proc: procOf(processes), uid: 1000, home: HOME });

feature("the bridge and its supervisor are known by more than their working directory", () => {
  unit("an install renamed start.sh's package directory away and the bridge moved home", {
    when: ["reading the stack", () => stack({
      19054: { cmdline: "bash bin/start.sh", cwd: "/home/u/.nvm/versions/node/v22/lib/node_modules/.agentmux-ZTspAblB (deleted)" },
      2008992: { cmdline: BRIDGE, cwd: HOME, ppid: 19054 },
    }, { pid: 2008992 })],
    then: ["both are still this stack's", (found) => {
      expect(found).toEqual({ bridges: [2008992], supervisors: [19054] });
    }],
  });

  unit("a bridge whose heartbeat is not written yet is known by its supervisor", {
    when: ["reading the stack before the first beat", () => stack({
      19054: { cmdline: "bash bin/start.sh", cwd: PACKAGE },
      2008992: { cmdline: BRIDGE, cwd: HOME, ppid: 19054 },
    }, null)],
    then: ["it is counted once", (found) => {
      expect(found.bridges).toEqual([2008992]);
    }],
  });

  unit("a bridge without start.sh is known by its own heartbeat", {
    when: ["reading the stack of an `npm start` bridge", () => stack({
      6231: { cmdline: BRIDGE, cwd: HOME, ppid: 1 },
    }, { pid: 6231 })],
    then: ["the heartbeat pid is the bridge", (found) => {
      expect(found).toEqual({ bridges: [6231], supervisors: [] });
    }],
  });

  unit("never resurrects a dead or recycled pid, nor another project's node index.mjs", {
    when: ["the heartbeat names an exited pid or a pid running something else", () => [
      stack({ 6231: { cmdline: BRIDGE, ppid: 1 } }, { pid: 9999 }),
      stack({ 6231: { cmdline: "vim notes.txt", ppid: 1 } }, { pid: 6231 }),
      stack({ 6231: { cmdline: "node index.mjs", cwd: "/home/u/lsrc/other", ppid: 4000 },
        4000: { cmdline: "bash bin/start.sh", cwd: "/home/u/lsrc/other" } }, null),
    ]],
    then: ["no bridge is invented", (results) => {
      for (const found of results) expect(found).toEqual({ bridges: [], supervisors: [] });
    }],
  });

  unit("processes of another HOME or another user belong to another stack", {
    when: ["a test's stack runs beside this one", () => stack({
      500: { cmdline: "bash bin/start.sh", cwd: "/tmp/t/lib/node_modules/agentmux", home: "/tmp/t/home" },
      501: { cmdline: BRIDGE, cwd: "/tmp/t/home", ppid: 500, home: "/tmp/t/home" },
      600: { cmdline: "bash bin/start.sh", cwd: PACKAGE, uid: 1001 },
    }, null)],
    then: ["none of them is counted", (found) => {
      expect(found).toEqual({ bridges: [], supervisors: [] });
    }],
  });

  unit("package directories are recognised as installed and after a replace", {
    when: ["classifying working directories", () => [
      PACKAGE, `${PACKAGE} (deleted)`, "/x/node_modules/.agentmux-ZTspAblB (deleted)", "/home/u/lsrc/agentmux",
      HOME, "/x/node_modules/.agentmux-ZTspAblB", "/home/u/lsrc/agentmux-old",
    ].map(isAgentmuxPackageDir)],
    then: ["only agentmux packages match", (matches) => {
      expect(matches).toEqual([true, true, true, true, false, false, false]);
    }],
  });
});
