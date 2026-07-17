// Doctor rules: every check is a contract about a silent failure mode.
// Pure functions with injected observations — no live system needed.

import { feature, unit, expect } from "bdd-vitest";
import {
  checkContextBridge,
  checkDeliveryQueue,
  checkGuardCronHeartbeats,
  checkNativeRuntimeFleet,
  checkSuggestionsBoard,
  checkTmuxClients,
  checkTmuxPaneGeometry,
  formatDoctorReport,
  observeTmuxFleet,
  SUGGESTIONS_BRIDGE_STALE_MS,
  TMUX_MIN_PANE_COLUMNS,
  TMUX_MIN_PANE_ROWS,
  checkTmuxVersion,
  FAIL, OK, WARN,
  checkBridgeMode, checkBridgeProcess, checkHeartbeatHealth, checkHooksInstalled, checkSupervisors,
  checkLedger, checkTmux, overallStatus,
} from "./doctor.mjs";
import { classifyHeartbeat, HEARTBEAT_STALE_MS } from "./heartbeat.mjs";

const NOW = new Date("2026-07-08T12:00:00Z").getTime();
const beatAt = (iso, version = "1.20.37") => ({ ts: iso, pid: 1, version, startedAt: iso });

feature("Suggestions board and comment-bridge health", () => {
  unit("a successful probe and fresh completed sync are one green row", {
    when: ["checking a fresh source board", () => checkSuggestionsBoard({
      probe: { ok: true, status: 200, projectId: "source" },
      lastSuccessfulSyncAt: NOW - 45_000,
      now: NOW,
    })],
    then: ["the endpoint and exact successful-sync time are visible", (result) => {
      expect(result.status).toBe(OK);
      expect(result.detail).toContain("HTTP 200 (source)");
      expect(result.detail).toContain("45s ago");
      expect(result.detail).toContain("2026-07-08T11:59:15.000Z");
    }],
  });

  unit("HTTP 401 is a red row with the read-token repair", {
    when: ["checking an auth flip", () => checkSuggestionsBoard({
      probe: { ok: false, status: 401, error: "http: GET /api/tickets returned 401" },
      lastSuccessfulSyncAt: NOW - 40 * 60_000,
      now: NOW,
    })],
    then: ["the failure and fix are explicit", (result) => {
      expect(result.status).toBe(FAIL);
      expect(result.detail).toContain("HTTP 401");
      expect(result.detail).toContain("40m ago");
      expect(result.hint).toContain("READ_TOKEN");
      expect(formatDoctorReport([result])).toContain("❌  suggestions board");
    }],
  });

  unit("HTTP 500 is a red row with deployment-health direction", {
    when: ["checking a server failure", () => checkSuggestionsBoard({
      probe: { ok: false, status: 500, error: "http: GET /api/tickets returned 500" },
      lastSuccessfulSyncAt: NOW - 60_000,
      now: NOW,
    })],
    then: ["the server-side repair is explicit", (result) => {
      expect(result.status).toBe(FAIL);
      expect(result.hint).toContain("deployment health");
    }],
  });

  unit("a reachable board cannot hide a stale comment bridge", {
    when: ["checking beyond the freshness budget", () => checkSuggestionsBoard({
      probe: { ok: true, status: 200, projectId: "source" },
      lastSuccessfulSyncAt: NOW - SUGGESTIONS_BRIDGE_STALE_MS - 60_000,
      now: NOW,
    })],
    then: ["the row is red and points to cron", (result) => {
      expect(result.status).toBe(FAIL);
      expect(result.hint).toContain("cron");
    }],
  });

  unit("an optional unconfigured installation warns without pretending to probe", {
    when: ["checking without bridge config", () => checkSuggestionsBoard({ configured: false })],
    then: ["install direction is visible", (result) => {
      expect(result.status).toBe(WARN);
      expect(result.hint).toContain("install-suggestions-comment-bridge");
    }],
  });
});

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

feature("managed native runtime fleet truth", () => {
  unit("is absent only when neither ownership records nor configuration exist", {
    when: ["checking a legacy-only host", () => checkNativeRuntimeFleet()],
    then: ["does not add noise", (rows) => expect(rows).toEqual([])],
  });

  unit("fails closed when a configured runtime is offline", {
    when: ["checking an offline canary with no owned process", () => checkNativeRuntimeFleet({
      configured: [{
        url: "http://127.0.0.1:8812",
        online: false,
        error: "connection refused",
      }],
    })],
    then: ["both the fleet total and exact port are red", (rows) => {
      expect(rows.map((row) => row.status)).toEqual([FAIL, FAIL]);
      expect(rows[1].name).toBe("native :8812");
      expect(rows[1].hint).toContain("fail closed");
    }],
  });

  unit("shows both managed runtimes even when only one is configured", {
    when: ["checking the live 8811 plus 8813 shape", () => checkNativeRuntimeFleet({
      managed: [
        {
          port: 8811,
          online: true,
          health: { bootId: "boot-web", agents: 3, running: 0 },
          paths: { dataDir: "/data/web-ui" },
        },
        {
          port: 8813,
          online: true,
          health: { bootId: "boot-watch", agents: 15, running: 0 },
          paths: { dataDir: "/data/code-pilot" },
        },
      ],
      configured: [{
        url: "http://127.0.0.1:8813",
        online: true,
        health: { bootId: "boot-watch", agents: 15, running: 0 },
      }],
    })],
    then: ["the total and each port, boot, agent count and data directory are visible", (rows) => {
      expect(rows).toHaveLength(3);
      expect(rows[0]).toMatchObject({
        name: "native runtimes",
        status: OK,
        detail: "2 managed · 2 online · 0 active turns · 1 configured",
      });
      expect(rows[1]).toMatchObject({ name: "native :8811", status: OK });
      expect(rows[1].detail).toContain("boot boot-web · 3 agents");
      expect(rows[1].detail).toContain("data /data/web-ui · managed-only");
      expect(rows[2]).toMatchObject({ name: "native :8813", status: OK });
      expect(rows[2].detail).toContain("boot boot-watch · 15 agents");
      expect(rows[2].detail).toContain("data /data/code-pilot · configured");
    }],
  });

  unit("fails loudly when ownership discovery itself cannot enumerate", {
    when: ["checking a discovery error", () => checkNativeRuntimeFleet({
      discoveryError: "permission denied",
    })],
    then: ["the report says a runtime may be invisible", (rows) => {
      expect(rows.map((row) => row.status)).toEqual([FAIL, FAIL]);
      expect(rows[1].name).toBe("native discovery");
      expect(rows[1].hint).toContain("running without appearing");
    }],
  });
});

feature("tmux bracketed-paste requirement", () => {
  unit("tmux older than 3.2 fails before long prompt delivery can silently degrade", {
    when: ["checking tmux 3.1c", () => checkTmuxVersion({ version: "tmux 3.1c" })],
    then: ["the minimum is explicit", (c) => {
      expect(c.status).toBe(FAIL);
      expect(c.detail).toContain("3.2+");
    }],
  });

  unit("letter-suffixed tmux 3.2 releases support bracketed paste", {
    when: ["checking tmux 3.2a", () => checkTmuxVersion({ version: "tmux 3.2a" })],
    then: ["the host is accepted", (c) => expect(c.status).toBe(OK)],
  });
});

feature("tmux pane usability and attachment health", () => {
  unit("one observation contract collects every session and pane field", {
    given: ["a tmux adapter with two fleet sessions", () => {
      const calls = [];
      const tmux = async (command) => {
        calls.push(command);
        if (command.startsWith("list-sessions")) return { stdout: "claw\t1\nai\t0\n" };
        return { stdout: "claw\t0\t340\t48\nai\t2\t26\t7\n" };
      };
      return { calls, tmux };
    }],
    when: ["observing attachment and geometry", async ({ calls, tmux }) => ({
      calls,
      result: await observeTmuxFleet(tmux),
    })],
    then: ["both queries and typed observations are exact", ({ calls, result }) => {
      expect(calls).toEqual([
        "list-sessions -F '#{session_name}\t#{session_attached}'",
        "list-panes -a -F '#{session_name}\t#{pane_index}\t#{pane_width}\t#{pane_height}'",
      ]);
      expect(result).toEqual({
        sessions: [{ name: "claw", attached: 1 }, { name: "ai", attached: 0 }],
        panes: [
          { session: "claw", pane: 0, width: 340, height: 48 },
          { session: "ai", pane: 2, width: 26, height: 7 },
        ],
        error: null,
      });
    }],
  });

  unit("a 26x7 fleet is operator-unusable without diagnosing delivery", {
    given: ["two unusably small panes", () => ({
      panes: [
        { session: "claw", pane: 0, width: 26, height: 7 },
        { session: "ai", pane: 2, width: 59, height: 24 },
      ],
    })],
    when: ["checking operator geometry", (fleet) => checkTmuxPaneGeometry(fleet)],
    then: ["doctor is red, factual, and gives resize plus attach recovery", (result) => {
      expect(result.status).toBe(FAIL);
      expect(result.detail).toContain("claw:0 26x7");
      expect(result.detail).toContain("ai:2 59x24");
      expect(result.detail).toContain("operator minimum");
      expect(result.detail).toContain(`${TMUX_MIN_PANE_COLUMNS}x${TMUX_MIN_PANE_ROWS}`);
      expect(`${result.detail} ${result.hint}`).not.toMatch(/delivery|ingest|prompt|queue/iu);
      expect(result.hint).toContain("attach a client");
      expect(result.hint).toContain("tmux resize-window");
      expect(formatDoctorReport([result])).toContain("❌  tmux pane geometry");
    }],
  });

  unit("the exact 60x20 boundary remains usable", {
    when: ["checking the minimum geometry", () => checkTmuxPaneGeometry({
      panes: [{ session: "claw", pane: 0, width: 60, height: 20 }],
    })],
    then: ["doctor stays green", (result) => expect(result).toMatchObject({
      status: OK,
      detail: "1/1 panes at least 60x20",
    })],
  });

  unit("every session without an attached client is a visible warning", {
    when: ["checking one attached and two detached sessions", () => checkTmuxClients({
      sessions: [
        { name: "claw", attached: 1 },
        { name: "ai", attached: 0 },
        { name: "lsrc", attached: 0 },
      ],
    })],
    then: ["doctor names both trigger conditions without calling them failures", (result) => {
      expect(result.status).toBe(WARN);
      expect(result.detail).toBe("2/3 sessions without a client: ai, lsrc");
      expect(result.hint).toContain("default-size");
      expect(formatDoctorReport([result])).toContain("⚠️  tmux clients");
    }],
  });

  unit("a failed tmux health query cannot produce green secondary rows", {
    when: ["observing a broken socket", async () => {
      const fleet = await observeTmuxFleet(async () => { throw new Error("no server"); });
      return {
        fleet,
        socket: checkTmux({ sessions: [], error: fleet.error }),
        geometry: checkTmuxPaneGeometry(fleet),
        clients: checkTmuxClients(fleet),
      };
    }],
    then: ["the primary row fails and derived rows are omitted", ({ fleet, socket, geometry, clients }) => {
      expect(fleet.error).toBe("no server");
      expect(socket.status).toBe(FAIL);
      expect(geometry).toBeNull();
      expect(clients).toBeNull();
    }],
  });

  unit("native-only fleets add no tmux geometry noise", {
    when: ["checking optional tmux observations", () => ({
      geometry: checkTmuxPaneGeometry({ required: false }),
      clients: checkTmuxClients({ required: false }),
    })],
    then: ["both extra rows stay absent", ({ geometry, clients }) => {
      expect(geometry).toBeNull();
      expect(clients).toBeNull();
    }],
  });
});

feature("bridge ownership mode check", () => {
  unit("manual running mode disables dead-stack autostart", {
    when: ["checking", () => checkBridgeMode({ mode: "manual", running: true })],
    then: ["manual policy", (c) => {
      expect(c.status).toBe(OK);
      expect(c.detail).toContain("no dead-stack autostart");
    }],
  });

  unit("an intentionally stopped bridge is not mistaken for auto-recovery", {
    when: ["checking", () => checkBridgeMode({ mode: "stopped", running: false })],
    then: ["stopped policy", (c) => expect(c.detail).toContain("intentionally")],
  });

  unit("stopped policy with a live process warns", {
    when: ["checking", () => checkBridgeMode({ mode: "stopped", running: true })],
    then: ["policy mismatch", (c) => expect(c.status).toBe(WARN)],
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

  // The version is a hand-maintained proxy for the code, and a bug fix bumps
  // nothing, so a matching version proves only that nobody edited a string.
  // agentmux d3e67ae landed 05:47 on 2026-07-16 while the bridge had been up
  // since 02:48, both reading v1.24.1: this row stayed green for three hours
  // while the merged fix was provably not the code being run. The module's own
  // contract is "bridge started before the latest commit", so measure that.
  const bootedAt = (msBeforeNow) => ({
    ...beatAt("2026-07-08T11:59:30Z"),
    startedAt: new Date(NOW - msBeforeNow).toISOString(),
  });

  unit("a bridge older than the newest commit is stale code even when nobody bumped the version", {
    given: ["a bridge that booted three hours before the repo's newest commit", () =>
      bootedAt(3 * 60 * 60_000)],
    when: ["classifying against the very version the bridge is already running", (beat) =>
      classifyHeartbeat(beat, {
        repoVersion: "1.20.37", repoCodeChangedAt: NOW - 60_000, pidAlive: true, now: NOW,
      })],
    then: ["it is classified as stale code, not as a healthy heartbeat", (hb) =>
      expect(hb.state).toBe("stale-code")],
  });

  unit("a bridge booted after the newest commit is current", {
    given: ["a bridge that booted one minute ago", () => bootedAt(60_000)],
    when: ["classifying against an hour-old commit", (beat) =>
      classifyHeartbeat(beat, {
        repoVersion: "1.20.37", repoCodeChangedAt: NOW - 60 * 60_000, pidAlive: true, now: NOW,
      })],
    then: ["ok, so the row does not nag every healthy bridge", (hb) =>
      expect(hb.state).toBe("ok")],
  });

  unit("stale code found by commit time still renders the restart hint", {
    given: ["a bridge that predates the newest commit on an unchanged version", () => ({
      beat: bootedAt(3 * 60 * 60_000),
      repoVersion: "1.20.37", repoCodeChangedAt: NOW - 60_000, pidAlive: true, now: NOW,
    })],
    when: ["running the doctor check", (x) => checkHeartbeatHealth(x)],
    then: ["the operator reads that the bridge predates its code, and how to fix it", (c) => {
      expect(c.status).toBe(WARN);
      expect(c.name).toBe("bridge code");
      // What the operator is told is the contract. A matching version string
      // must never be allowed to render this as a green heartbeat.
      expect(c.detail).toContain("179 min");
      expect(c.detail).toContain("before the repo's newest commit");
      expect(c.hint).toContain("restart");
    }],
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

feature("scheduled guard heartbeats", () => {
  const fresh = (key, intervalSec, ageMs = 30_000) => ({
    key,
    intervalSec,
    beat: {
      schemaVersion: 1,
      key,
      intervalSec,
      ts: new Date(NOW - ageMs).toISOString(),
      metrics: {},
    },
  });

  unit("all fresh guard sweeps render one healthy doctor row", {
    when: ["checking", () => checkGuardCronHeartbeats({
      heartbeats: [fresh("comment-bridge", 60), fresh("fleet-progress", 1200)],
      now: NOW,
    })],
    then: ["green", (result) => {
      expect(result.status).toBe(OK);
      expect(result.detail).toContain("2/2 fresh");
    }],
  });

  unit("a beat older than twice its interval is RED", {
    when: ["checking", () => checkGuardCronHeartbeats({
      heartbeats: [
        fresh("fleet-progress", 1200),
        fresh("comment-bridge", 60, 120_001),
      ],
      now: NOW,
    })],
    then: ["fail with the exact guard", (result) => {
      expect(result.status).toBe(FAIL);
      expect(result.detail).toContain("RED 1/2");
      expect(result.detail).toContain("comment-bridge");
      expect(result.hint).toContain("successful sweep");
    }],
  });

  unit("a guard that never wrote is not omitted from doctor", {
    when: ["checking", () => checkGuardCronHeartbeats({
      heartbeats: [{ key: "board-curator", intervalSec: 3600, beat: null }],
      now: NOW,
    })],
    then: ["missing is red", (result) => {
      expect(result.status).toBe(FAIL);
      expect(result.detail).toContain("board-curator missing");
    }],
  });
});

feature("supervisor duplicates + crash loops", () => {
  unit("one supervisor is nothing to report (bridge check owns supervision)", {
    given: ["a single start.sh pid", () => checkSupervisors({ pids: [5996] })],
    when: ["checking", (c) => c],
    then: ["null — no row", (c) => { expect(c).toBeNull(); }],
  });

  unit("two supervisors fail loud (the 23h orphan class)", {
    given: ["two start.sh pids", () => checkSupervisors({ pids: [5996, 306341] })],
    when: ["checking", (c) => c],
    then: ["fail + kill hint", (c) => {
      expect(c.status).toBe(FAIL);
      expect(c.detail).toContain("orphan");
      expect(c.hint).toContain("live bridge pid");
    }],
  });

  unit("a fresh crash tail in bridge.log fails even with one visible pid", {
    given: ["crashLooping signal", () => checkSupervisors({ pids: [5996], crashLooping: true })],
    when: ["checking", (c) => c],
    then: ["fail naming the loop", (c) => {
      expect(c.status).toBe(FAIL);
      expect(c.detail).toContain("crash-looping");
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

  unit("hooks installed incl SessionStart is ok", {
    given: ["settings + file with all carrier events", () => checkHooksInstalled({
      settings: { hooks: { Stop: [amuxHook], Notification: [amuxHook], SessionStart: [amuxHook] } },
      hookFileExists: true,
    })],
    when: ["checking", (c) => c],
    then: ["ok listing events + hint carrier", (c) => {
      expect(c.status).toBe(OK);
      expect(c.detail).toContain("Stop");
      expect(c.detail).toContain("resume-hint via SessionStart");
    }],
  });

  unit("missing SessionStart registration fails loud (resume-hints would be silently off)", {
    given: ["settings without SessionStart", () => checkHooksInstalled({
      settings: { hooks: { Stop: [amuxHook], Notification: [amuxHook] } },
      hookFileExists: true,
    })],
    when: ["checking", (c) => c],
    then: ["fail + reinstall hint", (c) => {
      expect(c.status).toBe(FAIL);
      expect(c.detail).toContain("resume-hints are OFF");
      expect(c.hint).toContain("install-hooks");
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

  unit("native-only fleets do not require a tmux binary or socket", {
    given: ["no tmux observations for a native-only fleet", () => ({
      socket: checkTmux({ sessions: [], error: "no server", required: false }),
      version: checkTmuxVersion({ version: null, required: false }),
    })],
    when: ["checking both tmux rows", (checks) => checks],
    then: ["both are green and explicitly optional", ({ socket, version }) => {
      expect(socket.status).toBe(OK);
      expect(version.status).toBe(OK);
      expect(socket.detail).toContain("native-only");
      expect(version.detail).toContain("native-only");
    }],
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

feature("durable delivery queue health", () => {
  unit("an empty spool is healthy", {
    when: ["checking", () => checkDeliveryQueue({ stats: { total: 0 }, bridgeRunning: true })],
    then: ["ok", (r) => expect(r.status).toBe(OK)],
  });

  // On 2026-07-16 this row read `4 submitted, oldest (14511s); broker draining`
  // in green while ai:2 had ingested nothing for five hours and five straight
  // budgets had expired. Movement in the spool is not delivery to a pane.
  unit("a target that keeps re-proving the same failure is never called draining", {
    when: ["checking", () => checkDeliveryQueue({
      stats: {
        total: 4, pending: 3, submitted: 1, oldestCreatedAt: NOW - 14_511_000,
        notIngestingTargets: [{ agentName: "ai", pane: 2, unverifiedStreak: 5 }],
      },
      bridgeRunning: true,
      now: NOW,
    })],
    then: ["the row fails and names the pane that ingests nothing", (result) => {
      expect(result.status).toBe(FAIL);
      expect(result.detail).toContain("ai:2");
      expect(result.detail).toContain("5 budgets");
      expect(result.hint).toContain("resend");
    }],
  });

  // The delivery breaker keeps a dead target's queue short, so an empty spool
  // is that target's symptom rather than its absence. Reporting `empty` here
  // would restore the same lie with a tidier queue.
  unit("draining the spool does not clear a target that never ingested", {
    when: ["checking", () => checkDeliveryQueue({
      stats: {
        total: 0,
        notIngestingTargets: [{ agentName: "ai", pane: 2, unverifiedStreak: 2 }],
      },
      bridgeRunning: true,
      now: NOW,
    })],
    then: ["an empty queue cannot outrank a target proven not to ingest", (result) => {
      expect(result.status).toBe(FAIL);
      expect(result.detail).toContain("ai:2");
    }],
  });

  unit("queued work cannot disappear behind an intentional bridge stop", {
    when: ["checking", () => checkDeliveryQueue({
      stats: { total: 2, pending: 2, drafted: 0, submitted: 0, blocked: 0, oldestCreatedAt: NOW - 30_000 },
      bridgeRunning: false,
      now: NOW,
    })],
    then: ["warn with resume direction", (r) => {
      expect(r.status).toBe(WARN);
      expect(r.detail).toContain("2 pending");
      expect(r.hint).toContain("start the bridge");
    }],
  });

  unit("an owned draft is visible as a warning", {
    when: ["checking", () => checkDeliveryQueue({
      stats: { total: 1, pending: 0, drafted: 1, submitted: 0, blocked: 0 },
      bridgeRunning: true,
    })],
    then: ["warn", (r) => expect(r.status).toBe(WARN)],
  });

  unit("a provisional owned paste is visible as a warning", {
    when: ["checking", () => checkDeliveryQueue({
      stats: {
        total: 1, pending: 0, pasting: 1, drafted: 0, submitted: 0, blocked: 0,
        oldestCreatedAt: NOW - 12_000,
      },
      bridgeRunning: true,
      now: NOW,
    })],
    then: ["the health row names the provisional state and its age", (result) => {
      expect(result.status).toBe(WARN);
      expect(result.detail).toContain("1 pasting");
      expect(result.detail).toContain("oldest 12s");
      expect(result.hint).toContain("FIFO head");
    }],
  });

  unit("the oldest live job is directly identifiable and points to amux queue", {
    when: ["checking one nine-hour stall", () => checkDeliveryQueue({
      stats: {
        total: 1, pending: 1, pasting: 0, drafted: 0, submitted: 0, blocked: 0,
        oldestCreatedAt: NOW - 9 * 60 * 60 * 1000,
        oldestJob: {
          id: "565b6ddcfce8ec7f0e688313d8245fdc",
          agentName: "ai",
          pane: 5,
          status: "pending",
        },
      },
      bridgeRunning: false,
      now: NOW,
    })],
    then: ["doctor names the exact job and the one-command drilldown", (result) => {
      expect(result.status).toBe(WARN);
      expect(result.detail).toContain("565b6ddcfce8ec7f0e688313d8245fdc");
      expect(result.detail).toContain("ai:5");
      expect(result.detail).toContain("32400s");
      expect(result.hint).toContain("amux queue");
    }],
  });

  unit("unresolved terminal notices cannot make the spool look empty", {
    when: ["checking a terminal receipt whose sender has not been notified", () => checkDeliveryQueue({
      stats: {
        total: 0,
        pendingNotices: 1,
        cancellationRequests: 0,
        oldestCreatedAt: NOW - 60_000,
        oldestJob: {
          id: "terminal-notice-job",
          agentName: "lsrc",
          pane: 8,
          status: "cancelled",
        },
      },
      bridgeRunning: true,
      now: NOW,
    })],
    then: ["doctor warns until the truthful receipt is visible", (result) => {
      expect(result.status).toBe(WARN);
      expect(result.detail).toContain("1 terminal notice");
      expect(result.hint).toContain("amux queue");
    }],
  });
});
