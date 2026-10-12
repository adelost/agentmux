import { feature, integration, expect } from "bdd-vitest";
import { vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { capacityEvents, capacityError } from "./fixtures/codex-capacity-2026-10-12.mjs";
const { createJsonlWatcher } = await import(process.env.AMUX_TEST_PACKAGE_ROOT
  ? join(process.env.AMUX_TEST_PACKAGE_ROOT, "channels/jsonl-watcher.mjs") : "../channels/jsonl-watcher.mjs");

feature("actual capacity evidence through the polling watcher and durable queue", () => {
  integration("an unchanged refused journal resumes once at the two-minute deadline", {
    given: ["an isolated journal and Codex SQLite error with the actual turn id", async () => {
      const root = mkdtempSync(join(tmpdir(), "amux-capacity-watcher-"));
      const old1 = process.env.AMUX_CODEX_PROFILE_1_HOME, old2 = process.env.AMUX_CODEX_PROFILE_2_HOME;
      const codexHome = join(root, "codex");
      process.env.AMUX_CODEX_PROFILE_1_HOME = codexHome;
      process.env.AMUX_CODEX_PROFILE_2_HOME = join(root, "other");
      const dir = join(root, "workspace"), paneDir = join(dir, ".agents", "0");
      mkdirSync(paneDir, { recursive: true });
      const sessions = join(codexHome, "sessions", "2026", "10", "12"); mkdirSync(sessions, { recursive: true });
      const thread = "019f5181-95b3-7e72-978b-1e74a246a86a";
      const file = join(sessions, `rollout-2026-10-12T07-08-00-${thread}.jsonl`);
      writeFileSync(file, [{ type: "session_meta", payload: { cwd: paneDir, source: "cli", originator: "codex-tui" } }, ...capacityEvents]
        .map(event => JSON.stringify(event)).join("\n") + "\n");
      const { DatabaseSync } = await import("node:sqlite");
      const db = new DatabaseSync(join(codexHome, "logs_2.sqlite"));
      db.exec("CREATE TABLE logs (id INTEGER PRIMARY KEY, thread_id TEXT, ts INTEGER, feedback_log_body TEXT)");
      db.prepare("INSERT INTO logs(thread_id, ts, feedback_log_body) VALUES(?, ?, ?)").run(thread, 1791789003,
        `turn.id=01a12ef1-69fa-70a3-9fbe-3d7994a8d712:run_turn: Turn error: ${capacityError}`);
      db.close();
      const agentsYamlPath = join(root, "agents.yaml");
      writeFileSync(agentsYamlPath, `testagent:\n  dir: ${dir}\n  panes:\n    - cmd: codex\n  discord:\n    \"test-channel\": 0\n`);
      const data = {}, state = { get: (key, fallback = {}) => data[key] ?? fallback, set: (key, value) => { data[key] = value; } };
      const queue = createDeliveryQueue({ rootDir: join(root, "queue"), recordAsk: () => {} });
      const broker = { queue, enqueue: request => queue.enqueue(request), runExclusive: (_name, _pane, work) => work() };
      const watcher = createJsonlWatcher({ agentsYamlPath, state, deliveryBroker: broker, log: () => {},
        discord: { send: async () => {} }, agent: { getContextPercent: () => null, captureScreen: async () => "› \n gpt-6.1-sol xhigh",
          promptTransportState: async () => ({ dialect: "codex", busy: false, state: "empty-idle" }) } });
      return { root, dir, watcher, queue, old1, old2 };
    }],
    when: ["polling the identical journal before and after two minutes", async fx => {
      const clock = vi.spyOn(Date, "now");
      clock.mockReturnValue(Date.parse(capacityEvents.at(-1).timestamp));
      await fx.watcher.checkPane("testagent", 0, fx.dir);
      expect(fx.queue.list("testagent", 0)).toHaveLength(0);
      clock.mockReturnValue(Date.parse(capacityEvents.at(-1).timestamp) + 120_000);
      await fx.watcher.checkPane("testagent", 0, fx.dir);
      await fx.watcher.checkPane("testagent", 0, fx.dir);
      return fx.queue.list("testagent", 0);
    }],
    then: ["the polling fast path still creates exactly one continuation", jobs => expect(jobs).toHaveLength(1)],
    cleanup: fx => {
      vi.restoreAllMocks(); fx.watcher.stop();
      for (const [key, value] of [["AMUX_CODEX_PROFILE_1_HOME", fx.old1], ["AMUX_CODEX_PROFILE_2_HOME", fx.old2]]) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      rmSync(fx.root, { recursive: true, force: true });
    },
  });
});
