import { feature, integration, expect } from "bdd-vitest";
import { vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { createJsonlWatcher } from "../channels/jsonl-watcher.mjs";

const switched = vi.hoisted(() => []);
vi.mock("../core/codex-account-quota.mjs", () => ({ readCodexAccountQuota: async profile => ({
  ok: true, account: { email: "target@example.test" }, limits: [{ limitId: "codex",
    windows: [{ windowMinutes: 10080, usedPercent: profile.id === "2" ? 100 : 24 }] }],
}) }));
vi.mock("../core/codex-account-switch.mjs", () => ({
  codexAccountContinuity: () => ({ ok: true }),
  switchCodexAccount: async args => { switched.push(args); return { kind: "switched" }; },
}));
vi.mock("../core/codex-session-transfer.mjs", () => ({ transferCodexSession: () => ({ ok: true, sessionId: "exact-session" }) }));
vi.mock("../core/codex-profiles.mjs", async original => ({ ...await original(), isCodexProfileAuthenticated: () => true }));

feature("late Codex refusal evidence does not strand an unchanged journal", () => {
  for (const worked of [false, true]) integration(`${worked ? "working turn" : "idle delivery"} recovers after the SQLite error arrives`, {
    given: ["the actual limit-ending shape, journal visible before its provider log", async () => {
      const root = mkdtempSync(join(tmpdir(), "amux-limit-watcher-"));
      const env = Object.fromEntries(["AMUX_CODEX_PROFILE_1_HOME", "AMUX_CODEX_PROFILE_2_HOME"].map(key => [key, process.env[key]]));
      const home = join(root, "two"), dir = join(root, "work");
      process.env.AMUX_CODEX_PROFILE_1_HOME = join(root, "one");
      process.env.AMUX_CODEX_PROFILE_2_HOME = home;
      mkdirSync(join(dir, ".agents", "0"), { recursive: true });
      const sessions = join(home, "sessions", "2026", "10", "15");
      mkdirSync(sessions, { recursive: true });
      const thread = "01a12fe3-d140-7842-86b3-68442e87b5ee";
      const file = join(sessions, `rollout-2026-10-15T22-18-00-${thread}.jsonl`);
      const events = [
        { type: "session_meta", payload: { cwd: join(dir, ".agents", "0"), source: "cli", originator: "codex-tui" } },
        { timestamp: "2026-10-15T22:18:50.694Z", type: "event_msg", payload: { type: "user_message", message: "Continue the assigned feature." } },
        { timestamp: "2026-10-15T22:18:50.700Z", type: "event_msg", payload: { type: "task_started" } },
        ...(worked ? [{ timestamp: "2026-10-15T22:18:50.800Z", type: "event_msg", payload: { type: "token_count", info: {} } }] : []),
        { timestamp: "2026-10-15T22:18:51.538Z", type: "event_msg", payload: { type: "task_complete", last_agent_message: null } },
      ];
      writeFileSync(file, events.map(event => JSON.stringify(event)).join("\n") + "\n");
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(home, "logs_2.sqlite"));
      db.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, thread_id TEXT, ts INTEGER, feedback_log_body TEXT)");
      const config = join(root, "agents.yaml");
      writeFileSync(config, `testagent:\n  dir: ${dir}\n  panes:\n    - cmd: codex\n  discord:\n    \"test-channel\": 0\n`);
      const data = { codex_profile_by_pane: { "testagent:0": "2" } };
      const state = { get: (key, fallback = {}) => data[key] ?? fallback, set: (key, value) => { data[key] = value; } };
      const queue = createDeliveryQueue({ rootDir: join(root, "queue"), recordAsk: () => {} });
      const broker = { queue, enqueue: request => queue.enqueue(request), runExclusive: (_name, _pane, work) => work() };
      const watcher = createJsonlWatcher({ agentsYamlPath: config, state, deliveryBroker: broker, log: () => {},
        discord: { send: async () => {} }, agent: { getContextPercent: () => null, captureScreen: async () => "› Ask Codex to do anything\n  ? for shortcuts  ⚠ 4 warnings · f2 to view",
          promptTransportState: async () => ({ dialect: "codex", busy: false, state: "empty-idle" }) } });
      switched.length = 0;
      return { root, dir, thread, db, env, watcher, queue };
    }],
    when: ["polling once without the error, then twice after only SQLite changes", async fx => {
      await fx.watcher.checkPane("testagent", 0, fx.dir);
      expect(fx.queue.list("testagent", 0)).toHaveLength(0);
      fx.db.prepare("INSERT INTO logs(thread_id, ts, feedback_log_body) VALUES(?, ?, ?)").run(fx.thread,
        Math.floor(Date.parse("2026-10-15T22:18:51.538Z") / 1000), "run_turn: Turn error: You’ve hit your usage limit.");
      await fx.watcher.checkPane("testagent", 0, fx.dir);
      await fx.watcher.checkPane("testagent", 0, fx.dir);
      return fx.queue.list("testagent", 0);
    }],
    then: ["the exact session switches from2 to1 once and gets one continuation", jobs => {
      expect(jobs).toHaveLength(1);
      expect(switched).toHaveLength(1);
      expect(switched[0]).toMatchObject({ current: { id: "2" }, target: { id: "1" }, continuity: { sessionId: "exact-session" } });
    }],
    cleanup: fx => {
      fx.watcher.stop(); fx.db.close();
      for (const [key, value] of Object.entries(fx.env)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
      rmSync(fx.root, { recursive: true, force: true });
    },
  });
});
