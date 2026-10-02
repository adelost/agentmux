import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { component, expect, feature } from "bdd-vitest";
import { vi } from "vitest";
import { cmdModel } from "./model.mjs";
import { dispatch } from "./commands.mjs";

feature("CLI Claude model selection", () => {
  component("raw Claude model text cannot bypass compact", {
    given: ["a configured Claude pane and an empty delivery queue", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-claude-model-raw-"));
      const configPath = join(root, "agents.yaml");
      writeFileSync(configPath, `fixture:\n  dir: ${root}\n  panes:\n    - { name: claude, cmd: claude }\n`);
      const queue = { enqueue: vi.fn(() => { throw new Error("raw model was queued"); }) };
      return { root, configPath, queue };
    }],
    when: ["sending a raw slash through amux fixture", async ctx => {
      const tmux = process.env.TMUX, pane = process.env.TMUX_PANE;
      delete process.env.TMUX; delete process.env.TMUX_PANE;
      try {
        return await dispatch(["fixture", "-p", "0", "/model claude-opus-5-5"], {
          configPath: ctx.configPath, lastFile: join(ctx.root, "last"), deliveryQueue: ctx.queue,
        }).catch(error => error);
      } finally {
        if (tmux === undefined) delete process.env.TMUX; else process.env.TMUX = tmux;
        if (pane === undefined) delete process.env.TMUX_PANE; else process.env.TMUX_PANE = pane;
      }
    }],
    then: ["the CLI refuses before queueing", (error, ctx) => {
      try { expect(error.message).toMatch(/bypasses compact/); expect(ctx.queue.enqueue).not.toHaveBeenCalled(); }
      finally { rmSync(ctx.root, { recursive: true, force: true }); }
    }],
  });
  component("an explicit choice uses the compact-first Claude path", {
    given: ["a configured Claude pane", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-claude-model-cli-"));
      const configPath = join(root, "agents.yaml");
      writeFileSync(configPath, `fixture:\n  dir: ${root}\n  panes:\n    - { name: claude, cmd: claude }\n`);
      const changer = vi.fn(async () => ({ ok: true, unchanged: true, model: "claude-opus-5-5" }));
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      return { root, configPath, changer, output };
    }],
    when: ["running amux model for Claude", ctx => cmdModel(["fixture", "-p", "0", "claude-opus-5-5"], {
      configPath: ctx.configPath, agent: {}, state: {}, deliveryQueue: {},
    }, { claudeModelChanger: ctx.changer })],
    then: ["the exact pane reaches the safe changer, not a raw slash", (_, ctx) => {
      try {
        expect(ctx.changer).toHaveBeenCalledOnce();
        expect(ctx.changer.mock.calls[0][0]).toMatchObject({ name: "fixture", pane: 0,
          targetModel: "claude-opus-5-5", paneDir: join(ctx.root, ".agents", "0") });
      } finally { ctx.output.mockRestore(); rmSync(ctx.root, { recursive: true, force: true }); }
    }],
  });
});

// The account catalog on 2026-10-02, when "/model gpt-6.1" was accepted unchecked.
const ACCOUNT = { ok: true, models: ["gpt-6.1-sol", "gpt-6-astra", "gpt-5.6-sol"].map(id => ({ id, listed: true })) };
const codexPane = () => {
  const root = mkdtempSync(join(tmpdir(), "amux-codex-model-cli-"));
  const configPath = join(root, "agents.yaml");
  writeFileSync(configPath, `fixture:\n  dir: ${root}\n  panes:\n    - { name: codex, cmd: codex }\n`);
  return { root, configPath, changer: vi.fn(async () => ({ ok: false, stage: "compact", reason: "stopped-by-test" })) };
};
const runCodexModel = (ctx, model) => cmdModel(["fixture", "-p", "0", model, "xhigh"], {
  configPath: ctx.configPath, agent: {}, state: { get: (_, fallback) => fallback, set() {} }, deliveryQueue: {},
}, { codexModelChanger: ctx.changer, codexModels: () => ACCOUNT }).catch(error => error);

feature("CLI Codex model selection", () => {
  component("a family name reaches the switch as the account's model id", {
    given: ["a configured Codex pane", codexPane],
    when: ["asking for gpt-6.1", ctx => runCodexModel(ctx, "gpt-6.1")],
    then: ["the switch is asked for gpt-6.1-sol", (_, ctx) => {
      try {
        expect(ctx.changer).toHaveBeenCalledOnce();
        expect(ctx.changer.mock.calls[0][0]).toMatchObject({ targetModel: "gpt-6.1-sol", targetEffort: "xhigh" });
      } finally { rmSync(ctx.root, { recursive: true, force: true }); }
    }],
  });
  component("an unknown model is refused before any compact or restart", {
    given: ["a configured Codex pane", codexPane],
    when: ["asking for gpt-7", ctx => runCodexModel(ctx, "gpt-7")],
    then: ["nothing runs and the choices are shown", (error, ctx) => {
      try {
        expect(ctx.changer).not.toHaveBeenCalled();
        expect(error.message).toBe("gpt-7 is not a Codex model on this account. Available: gpt-6.1-sol, gpt-6-astra, gpt-5.6-sol. fixture:0 keeps its current model.");
      } finally { rmSync(ctx.root, { recursive: true, force: true }); }
    }],
  });
});
