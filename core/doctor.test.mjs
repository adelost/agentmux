// Doctor rules: every check is a contract about a silent failure mode.
// Pure functions with injected observations — no live system needed.

import { feature, unit, expect } from "bdd-vitest";
import {
  checkContextBridge,
  FAIL, OK, WARN,
  checkBridgeProcess, checkHeartbeatHealth, checkHooksInstalled,
  checkLedger, checkTmux, overallStatus,
} from "./doctor.mjs";
import { classifyHeartbeat, HEARTBEAT_STALE_MS } from "./heartbeat.mjs";

const NOW = new Date("2026-07-08T12:00:00Z").getTime();
const beatAt = (iso, version = "1.20.37") => ({ ts: iso, pid: 1, version, startedAt: iso });

feature("bridge process check", () => {
  unit("no process is a failure with a start hint", {
    given: ["no pids", () => checkBridgeProcess({ pids: [], supervised: false })],
    when: ["checking", (c) => c],
    then: ["fail + hint", (c) => {
      expect(c.status).toBe(FAIL);
      expect(c.hint).toContain("amux serve");
    }],
  });

  unit("two instances warn about double-mirroring", {
    given: ["two pids", () => checkBridgeProcess({ pids: [1, 2], supervised: true })],
    when: ["checking", (c) => c],
    then: ["warn", (c) => expect(c.status).toBe(WARN)],
  });

  unit("unsupervised bridge warns (crash will not auto-restart)", {
    given: ["one unsupervised pid", () => checkBridgeProcess({ pids: [7], supervised: false })],
    when: ["checking", (c) => c],
    then: ["warn with supervision hint", (c) => {
      expect(c.status).toBe(WARN);
      expect(c.detail).toContain("UNSUPERVISED");
    }],
  });

  unit("one supervised pid is healthy", {
    given: ["one supervised pid", () => checkBridgeProcess({ pids: [7], supervised: true })],
    when: ["checking", (c) => c],
    then: ["ok", (c) => expect(c.status).toBe(OK)],
  });
});

feature("heartbeat classification", () => {
  unit("fresh beat on the repo version is ok", {
    given: ["a 30s-old beat", () => beatAt("2026-07-08T11:59:30Z")],
    when: ["classifying", (beat) =>
      classifyHeartbeat(beat, { repoVersion: "1.20.37", pidAlive: true, now: NOW })],
    then: ["ok", (hb) => expect(hb.state).toBe("ok")],
  });

  unit("fresh beat on an OLDER version = stale code (the invisible trap)", {
    given: ["a beat from v1.20.31", () => beatAt("2026-07-08T11:59:30Z", "1.20.31")],
    when: ["classifying against repo v1.20.37", (beat) =>
      classifyHeartbeat(beat, { repoVersion: "1.20.37", pidAlive: true, now: NOW })],
    then: ["stale-code with both versions", (hb) =>
      expect(hb).toEqual({ state: "stale-code", running: "1.20.31", repo: "1.20.37" })],
  });

  unit("stale beat + live pid = hung event loop", {
    given: ["a beat older than the stale window", () =>
      beatAt(new Date(NOW - HEARTBEAT_STALE_MS - 60000).toISOString())],
    when: ["classifying with pid alive", (beat) =>
      classifyHeartbeat(beat, { repoVersion: "1.20.37", pidAlive: true, now: NOW })],
    then: ["hung", (hb) => expect(hb.state).toBe("hung")],
  });

  unit("stale beat + no pid = dead", {
    given: ["an old beat", () => beatAt("2026-07-08T09:00:00Z")],
    when: ["classifying with pid gone", (beat) =>
      classifyHeartbeat(beat, { repoVersion: "1.20.37", pidAlive: false, now: NOW })],
    then: ["dead", (hb) => expect(hb.state).toBe("dead")],
  });

  unit("hung heartbeat renders as a doctor FAIL with a kill hint", {
    given: ["a hung classification input", () => ({
      beat: beatAt(new Date(NOW - HEARTBEAT_STALE_MS - 60000).toISOString()),
      repoVersion: "1.20.37", pidAlive: true, now: NOW,
    })],
    when: ["running the doctor check", (x) => checkHeartbeatHealth(x)],
    then: ["fail + kill hint", (c) => {
      expect(c.status).toBe(FAIL);
      expect(c.hint).toContain("kill");
    }],
  });
});

feature("hooks + ledger + tmux checks", () => {
  const amuxHook = { hooks: [{ type: "command", command: "exec node \"/x/amux-hook.mjs\"" }] };

  unit("missing hook script after install is a failure (repo moved)", {
    given: ["settings with hooks but no file on disk", () => checkHooksInstalled({
      settings: { hooks: { Stop: [amuxHook] } }, hookFileExists: false,
    })],
    when: ["checking", (c) => c],
    then: ["fail + reinstall hint", (c) => {
      expect(c.status).toBe(FAIL);
      expect(c.hint).toContain("install-hooks");
    }],
  });

  unit("hooks installed with script present is ok", {
    given: ["settings + file", () => checkHooksInstalled({
      settings: { hooks: { Stop: [amuxHook], Notification: [amuxHook] } },
      hookFileExists: true,
    })],
    when: ["checking", (c) => c],
    then: ["ok listing events", (c) => {
      expect(c.status).toBe(OK);
      expect(c.detail).toContain("Stop");
    }],
  });

  unit("oversized ledger warns that rotation is failing", {
    given: ["a 20MB ledger stat", () => checkLedger({
      stat: { size: 20 * 1024 * 1024, mtimeMs: NOW }, now: NOW,
    })],
    when: ["checking", (c) => c],
    then: ["warn", (c) => expect(c.status).toBe(WARN)],
  });

  unit("tmux error is a failure", {
    given: ["a socket error", () => checkTmux({ sessions: [], error: "no server" })],
    when: ["checking", (c) => c],
    then: ["fail", (c) => expect(c.status).toBe(FAIL)],
  });

  unit("overall status: worst wins", {
    given: ["ok + warn + fail", () => [
      { status: OK }, { status: WARN }, { status: FAIL },
    ]],
    when: ["aggregating", (checks) => overallStatus(checks)],
    then: ["fail", (s) => expect(s).toBe(FAIL)],
  });
});

feature("checkContextBridge", () => {
  unit("no claude panes configured is fine", {
    given: ["a codex-only setup", () => ({ claudePanes: 0, pushing: 0 })],
    when: ["checking", (args) => checkContextBridge(args)],
    then: ["ok", (r) => expect(r.status).toBe("ok")],
  });

  unit("zero pushing panes warns — the fallback family produced 0%/33%/100%", {
    given: ["5 claude panes, none pushing", () => ({ claudePanes: 5, pushing: 0 })],
    when: ["checking", (args) => checkContextBridge(args)],
    then: ["warn with a fix hint", (r) => {
      expect(r.status).toBe("warn");
      expect(r.hint).toContain("claude-ctx");
    }],
  });

  unit("partial coverage reports the ratio", {
    given: ["5 claude panes, 3 pushing", () => ({ claudePanes: 5, pushing: 3 })],
    when: ["checking", (args) => checkContextBridge(args)],
    then: ["ok with 3/5", (r) => {
      expect(r.status).toBe("ok");
      expect(r.detail).toContain("3/5");
    }],
  });
});
