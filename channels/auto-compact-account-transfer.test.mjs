import { feature, integration, expect } from "bdd-vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createAutoCompact } from "./auto-compact.mjs";
import { createPauseCompact } from "./pause-compact.mjs";
import { DEFAULT_CONFIG } from "../core/auto-compact.mjs";
import { getContextPercent, resetCodexSessionIndexForTests } from "../core/context.mjs";
import { createContextMaintenance, rememberContextCompact } from "../core/context-maintenance.mjs";
import { transferCodexSession } from "../core/codex-session-transfer.mjs";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { captureJsonlAppendCursor } from "../core/jsonl-append-cursor.mjs";
import { createState } from "../core/state.mjs";
import { verifiedCodexCompact } from "../core/verified-compact.mjs";
import { composerAgent } from "../test/fixtures/composer-agent.mjs";

feature("automatic maintenance after an account transfer", () => {
  let teardown;
  integration("a transferred session compacts once after its next completed task", {
    given: ["a compacted session is moved with the real transfer and keeps its durable receipt", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-transfer-poll-"));
      const dir = join(root, "repo", ".agents", "0");
      mkdirSync(dir, { recursive: true });
      const current = { home: join(root, ".codex") }, target = { home: join(root, "other-account") };
      const names = ["AMUX_CODEX_PROFILE_1_HOME", "AMUX_CODEX_PROFILE_2_HOME"];
      const oldEnv = Object.fromEntries(names.map(name => [name, process.env[name]]));
      teardown = { root, oldEnv };
      Object.assign(process.env, { AMUX_CODEX_PROFILE_1_HOME: current.home, AMUX_CODEX_PROFILE_2_HOME: target.home });
      resetCodexSessionIndexForTests();
      const sessionId = "11111111-1111-4111-8111-111111111111";
      const oldPath = join(current.home, "sessions", "2026", "10", "27", `rollout-${sessionId}.jsonl`);
      mkdirSync(join(current.home, "sessions", "2026", "10", "27"), { recursive: true });
      const clock = Date.now(), oldTime = new Date(clock - 2 * 3600000).toISOString();
      const usage = (tokens, timestamp) => ({ timestamp, type: "event_msg", payload: { type: "token_count",
        info: { last_token_usage: { input_tokens: tokens, output_tokens: 0, total_tokens: tokens }, model_context_window: 828400 } } });
      const encode = rows => rows.map(row => JSON.stringify(row)).join("\n") + "\n";
      writeFileSync(oldPath, encode([
        { timestamp: oldTime, type: "session_meta", payload: { id: sessionId, cwd: dir, source: "cli", originator: "codex-tui" } },
        { timestamp: oldTime, type: "turn_context", payload: { model: "gpt-6.1-sol", effort: "xhigh" } },
        { timestamp: oldTime, type: "compacted", payload: {} }, usage(40000, oldTime),
      ]));
      const state = createState(join(root, "state.json"));
      rememberContextCompact(state, "test", 0, { ok: true, sessionId,
        cursor: captureJsonlAppendCursor("codex-compact-events-v1", [oldPath]) });
      state.updateKey("context_maintenance_by_pane_v1", records => ({ ...records,
        "test:0": { ...records["test:0"], at: clock - 2 * 3600000 } }));
      const moved = transferCodexSession(dir, current, target, { writers: () => [] });
      expect(moved).toMatchObject({ ok: true });
      const configPath = join(root, "agents.yaml");
      writeFileSync(configPath, `test:\n  dir: ${join(root, "repo")}\n  panes:\n    - name: codex\n      cmd: codex --yolo\n`);
      const queue = createDeliveryQueue({ rootDir: join(root, "queue") });
      const transport = composerAgent({ dialect: "codex" });
      const send = transport.agent.sendOnly;
      transport.agent.getContext = async () => getContextPercent(dir, "codex");
      transport.agent.sendOnly = async (...args) => {
        const result = await send(...args);
        if (args[1] === "/compact") appendFileSync(moved.path, encode([
          { timestamp: new Date().toISOString(), type: "compacted", payload: {} },
          usage(40000, new Date().toISOString()),
        ]));
        return result;
      };
      const makePoller = () => {
        const maintenance = createContextMaintenance({ agent: transport.agent, state, queue: {
          list: (...args) => queue.list(...args), acquireSessionLease: (...args) => queue.acquireTargetLease(...args),
        }, resolveTarget: () => ({ engine: "codex", dir }), recordCompact: () => {},
        compactFor: () => options => verifiedCodexCompact({ ...options, sleep: async () => {}, settleMs: 0, pollMs: 0, pollAttempts: 2 }) });
        return createAutoCompact({ agent: transport.agent, agentsYamlPath: configPath,
          tmux: async () => ({ stdout: "0 34" }), config: DEFAULT_CONFIG, contextMaintenance: maintenance,
          pauseCompact: createPauseCompact({ contextMaintenance: maintenance, state, modes: { claude: "off", codex: "on" },
            windDownMode: "off", record: () => {} }), log: () => {} });
      };
      return { root, dir, oldEnv, moved, encode, usage, transport, makePoller };
    }],
    when: ["the real poller sees the unchanged copy, then a completed task, then is reconstructed", async ctx => {
      const poller = ctx.makePoller();
      await poller.tick();
      const beforeWork = [...ctx.transport.pane.submitted];
      const timestamp = new Date(Date.now() - 120000).toISOString();
      appendFileSync(ctx.moved.path, ctx.encode([
        { timestamp, type: "event_msg", payload: { type: "task_started" } },
        { timestamp, type: "event_msg", payload: { type: "user_message", message: "Complete the next bounded task" } },
        ctx.usage(433932, timestamp),
        { timestamp, type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "Saved the result" }] } },
        { timestamp, type: "event_msg", payload: { type: "task_complete", last_agent_message: "Saved the result" } },
      ]));
      await poller.tick();
      const afterWork = [...ctx.transport.pane.submitted];
      await ctx.makePoller().tick();
      return { beforeWork, afterWork, afterReload: [...ctx.transport.pane.submitted], context: getContextPercent(ctx.dir, "codex") };
    }],
    then: ["one compact reaches the composer, its native boundary reduces context, and reload does not repeat it", result => {
      expect(result.beforeWork).toEqual([]);
      expect(result.afterWork).toEqual(["/compact"]);
      expect(result.afterReload).toEqual(["/compact"]);
      expect(result.context.tokens).toBe(40000);
    }], cleanup: context => {
      const ctx = context || teardown;
      for (const [name, value] of Object.entries(ctx.oldEnv)) {
        if (value === undefined) delete process.env[name]; else process.env[name] = value;
      }
      resetCodexSessionIndexForTests();
      rmSync(ctx.root, { recursive: true, force: true });
    },
  });
});
