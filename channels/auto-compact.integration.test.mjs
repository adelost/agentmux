// End-to-end test of the auto-compact poll loop (tick), exercising the real
// status detection, context parsing, decision logic, in-flight lock, and the
// verify-before-refire floor + tiny-pane guard together. Drives tick()
// repeatedly against synthetic pane captures and asserts how many /compact
// commands actually get sent — the regression that mattered was a runaway
// firing dozens of /compact into a pane whose context never dropped.

import { feature, unit, expect } from "bdd-vitest";
import { writeFileSync, mkdtempSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createAutoCompact } from "./auto-compact.mjs";
import { DEFAULT_CONFIG } from "../core/auto-compact.mjs";

const yield_ = () => new Promise((r) => setTimeout(r, 5));

function writeYaml() {
  const dir = mkdtempSync(join(tmpdir(), "amux-ac-"));
  const path = join(dir, "agents.yaml");
  // No discord mapping → findChannelForPane returns null → fireCompact skips
  // all Discord I/O but still sends /compact. Keeps the test offline.
  writeFileSync(path, `test:\n  dir: ${dir}\n  id: 00000000-0000-0000-0000-000000000099\n  panes:\n    - name: claude\n      cmd: claude\n`);
  return { path, dir };
}

function encodeClaudePath(dir) {
  return dir.replace(/[\/\.]/g, "-");
}

function writeClaudeModel(fakeHome, paneDir, model) {
  const projectDir = join(fakeHome, ".claude", "projects", encodeClaudePath(paneDir));
  mkdirSync(projectDir, { recursive: true });
  writeFileSync(join(projectDir, "session.jsonl"), JSON.stringify({
    type: "assistant",
    message: {
      role: "assistant",
      model,
      content: [{ type: "text", text: "ok" }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 1 },
    },
  }) + "\n");
}

const CONTENT = {
  full100: ["work output", "  ⬆ test │ Opus 4.7 │ 4 ██████████ 100%", "  1000000 tokens", "❯ "].join("\n"),
  drop30: ["Compacted.", "  ⬆ test │ Opus 4.7 │ 4 ███░░░░░░░ 30%", "  300000 tokens", "❯ "].join("\n"),
  narrow314k: ["done", "────", "❯ ", "  ⏵⏵ bypass permissions on", "   314000 tokens"].join("\n"),
};

// Build the injected deps. `state.content` is read fresh each capture so a
// test can simulate a compact succeeding (context drops) mid-run.
function harness({ height = 50, content = CONTENT.full100 } = {}) {
  const { path, dir } = writeYaml();
  const state = { content, fires: 0, rootDir: dir };
  const agent = {
    capturePane: async () => state.content,
    sendOnly: async (_name, cmd) => { if (cmd === "/compact") state.fires++; },
  };
  const tmux = async () => ({ stdout: `0 ${height}` });
  const discord = { send: async () => {} };
  const config = { ...DEFAULT_CONFIG, threshold: 70, graceMs: 0, compactLockMs: 0, minIdleMs: 0 };
  const ac = createAutoCompact({
    agent, agentsYamlPath: path, discord, tmux, config, log: () => {},
  });
  return { ac, state };
}

async function ticks(ac, n) {
  for (let i = 0; i < n; i++) { await ac.tick(); await yield_(); }
}

feature("auto-compact tick — runaway prevention (the real bug)", () => {
  unit("pane stuck at 100% whose /compact never reduces context fires /compact AT MOST ONCE", {
    given: ["normal-height pane, context always reads 100%", () => harness({ content: CONTENT.full100 })],
    when: ["running 8 poll ticks", async ({ ac, state }) => { await ticks(ac, 8); return state; }],
    then: ["exactly one /compact sent, then suppressed forever", (state) => {
      expect(state.fires).toBe(1);
    }],
  });

  unit("1-row pane never gets /compact (unreadable redraw-soup)", {
    given: ["pane_height=1, content reads 100%", () => harness({ height: 1, content: CONTENT.full100 })],
    when: ["running 8 poll ticks", async ({ ac, state }) => { await ticks(ac, 8); return state; }],
    then: ["zero /compact sent", (state) => {
      expect(state.fires).toBe(0);
    }],
  });

  unit("successful compact (context drops) fires once and stops; no suppression lock-up", {
    given: ["pane at 100% that drops to 30% after the first compact", () => harness({ content: CONTENT.full100 })],
    when: ["warn, compact, then context drops", async ({ ac, state }) => {
      await ac.tick(); await yield_();              // warn
      await ac.tick(); await yield_();              // compact (fires once)
      state.content = CONTENT.drop30;               // compact worked
      await ticks(ac, 4);                           // below threshold → cancel, no more fires
      return state;
    }],
    then: ["exactly one /compact", (state) => {
      expect(state.fires).toBe(1);
    }],
  });

  unit("uses per-pane cwd for context fallback instead of shared agent root", {
    given: ["narrow pane with 314k tokens + 1M model only in .agents/0 jsonl", () => {
      const oldHome = process.env.HOME;
      const fakeHome = mkdtempSync(join(tmpdir(), "amux-ac-home-"));
      process.env.HOME = fakeHome;
      const h = harness({ content: CONTENT.narrow314k });
      writeClaudeModel(fakeHome, join(h.state.rootDir, ".agents", "0"), "claude-opus-4-8");
      return { ...h, oldHome, fakeHome };
    }],
    when: ["running poll ticks", async ({ ac, state, oldHome, fakeHome }) => {
      await ticks(ac, 3);
      return { state, oldHome, fakeHome };
    }],
    then: ["no false /compact fires; 314k is ~31% of the pane's 1M context", ({ state, oldHome, fakeHome }) => {
      const fires = state.fires;
      process.env.HOME = oldHome;
      rmSync(fakeHome, { recursive: true, force: true });
      expect(fires).toBe(0);
    }],
  });
});
