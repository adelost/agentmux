import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { vi } from "vitest";
import { dispatch } from "./commands.mjs";
import {
  clearPaneComposer,
  escapePaneComposer,
  sendComposerKeys,
} from "./tmux.mjs";

function fixture({ discord = true, snapshot = "› composer" } = {}) {
  const root = mkdtempSync(join(tmpdir(), "amux-composer-control-"));
  const configPath = join(root, "agents.yaml");
  writeFileSync(configPath, [
    "target:",
    "  dir: /tmp/target",
    "  panes:",
    "    - cmd: codex",
    ...(discord ? ["  discord:", "    target-channel: 0"] : []),
    "broker:",
    "  dir: /tmp/broker",
    "  panes:",
    "    - cmd: codex",
    "    - cmd: codex",
    "    - cmd: codex",
    ...(discord ? ["  discord:", "    sender-channel: 2"] : []),
    "",
  ].join("\n"));
  const tmuxCalls = [];
  const events = [];
  const mirrors = [];
  const ctx = {
    configPath,
    lastFile: join(root, "last"),
    tmux: vi.fn(async (command) => { tmuxCalls.push(command); return { stdout: "" }; }),
    agent: {
      isNativeTarget: () => false,
      captureScreen: vi.fn(async () => snapshot),
    },
  };
  return { root, configPath, ctx, tmuxCalls, events, mirrors };
}

const opts = (fx, extra = {}) => ({
  actor: "broker:2",
  controlId: "control-123",
  now: () => new Date("2026-07-15T07:00:00.000Z"),
  record: (event) => fx.events.push(event),
  mirrorDispatch: async (message) => fx.mirrors.push(message),
  ...extra,
});

feature("composer control adapter", () => {
  unit("allowlisted keys have a durable fence, exact tmux write and two mirrors", {
    given: ["a target and broker channel", () => fixture()],
    when: ["sending bounded keys", async (fx) => {
      const receipt = await sendComposerKeys(
        fx.ctx, "target", 0, ["Escape", "C-a", "C-k"], opts(fx),
      );
      return { fx, receipt };
    }],
    then: ["requested necessarily precedes sent", ({ fx, receipt }) => {
      expect(receipt).toEqual({
        controlId: "control-123",
        action: "keys",
        keys: ["Escape", "C-a", "C-k"],
        target: "target:0",
      });
      expect(fx.tmuxCalls).toEqual([
        "send-keys -t 'target:.0' Escape C-a C-k",
      ]);
      expect(fx.events.map((event) => event.event)).toEqual([
        "composer_control_requested",
        "composer_control_sent",
      ]);
      expect(fx.events[0]).toMatchObject({
        session: "target", pane: 0, actor: "broker:2",
        action: "keys", keys: ["Escape", "C-a", "C-k"],
      });
      expect(fx.mirrors).toEqual([
        { channelId: "target-channel",
          content: "[composer-control from broker:2] keys Escape C-a C-k (control-123)" },
        { channelId: "sender-channel",
          content: "`amux keys target -p 0 Escape C-a C-k` → sent (control-123)" },
      ]);
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });

  unit("rejected raw keys cannot create provenance, mirrors or physical writes", {
    given: ["an otherwise live target", () => fixture()],
    when: ["trying tmux's command flag", async (fx) => {
      let error;
      try { await sendComposerKeys(fx.ctx, "target", 0, ["-X", "cancel"], opts(fx)); }
      catch (caught) { error = caught; }
      return { fx, error };
    }],
    then: ["the boundary is untouched", ({ fx, error }) => {
      expect(error.message).toContain("not allowed");
      expect(fx.tmuxCalls).toEqual([]);
      expect(fx.events).toEqual([]);
      expect(fx.mirrors).toEqual([]);
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });

  unit("clearline is one exact Escape,C-a,C-k write", {
    given: ["a foreign composer", () => fixture({ discord: false })],
    when: ["clearing explicitly", async (fx) => {
      const receipt = await clearPaneComposer(fx.ctx, "target", 0, opts(fx));
      return { fx, receipt };
    }],
    then: ["C-u is absent", ({ fx, receipt }) => {
      expect(receipt.action).toBe("clearline");
      expect(receipt.keys).toEqual(["Escape", "C-a", "C-k"]);
      expect(fx.tmuxCalls[0]).not.toContain("C-u");
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });

  unit("one esc invocation closes a detected transcript pager with internal q", {
    given: ["a Codex transcript pager", () => fixture({
      discord: false,
      snapshot: "/ T R A N S C R I P T /\nq to quit",
    })],
    when: ["escaping", async (fx) => {
      const receipt = await escapePaneComposer(fx.ctx, "target", 0, opts(fx));
      return { fx, receipt };
    }],
    then: ["q exits it without extra Escape presses", ({ fx, receipt }) => {
      expect(receipt).toMatchObject({ action: "esc-pager", keys: ["q"], pager: true });
      expect(fx.tmuxCalls).toEqual(["send-keys -t 'target:.0' q"]);
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });

  unit("a physical tmux failure is fenced as failed and never mirrored", {
    given: ["a target whose pane write fails", () => {
      const fx = fixture();
      fx.ctx.tmux = vi.fn(async () => { throw new Error("pane unavailable"); });
      return fx;
    }],
    when: ["submitting Enter", async (fx) => {
      let error;
      try {
        await sendComposerKeys(fx.ctx, "target", 0, ["Enter"], {
          ...opts(fx), action: "enter",
        });
      } catch (caught) { error = caught; }
      return { fx, error };
    }],
    then: ["the ledger distinguishes intent from delivery", ({ fx, error }) => {
      expect(error.message).toBe("pane unavailable");
      expect(fx.events.map((event) => event.event)).toEqual([
        "composer_control_requested",
        "composer_control_failed",
      ]);
      expect(fx.mirrors).toEqual([]);
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });

  unit("a lost sent receipt is fail-loud and never invites a duplicate retry", {
    given: ["a ledger that fails after recording intent", () => {
      const fx = fixture();
      let writes = 0;
      fx.record = (event) => {
        writes += 1;
        if (writes === 2) throw new Error("ledger unavailable");
        fx.events.push(event);
      };
      return fx;
    }],
    when: ["the physical Enter succeeds", async (fx) => {
      let error;
      try {
        await sendComposerKeys(fx.ctx, "target", 0, ["Enter"], {
          ...opts(fx), action: "enter", record: fx.record,
        });
      } catch (caught) { error = caught; }
      return { fx, error };
    }],
    then: ["the caller sees an ambiguous-but-sent fence", ({ fx, error }) => {
      expect(error.message).toContain("was sent but its receipt failed; do not retry");
      expect(fx.tmuxCalls).toEqual(["send-keys -t 'target:.0' Enter"]);
      expect(fx.events.map((event) => event.event)).toEqual([
        "composer_control_requested",
      ]);
      expect(fx.mirrors).toHaveLength(2);
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });

  unit("native panes fail closed before provenance or mutation", {
    given: ["a native-runtime target", () => {
      const fx = fixture();
      fx.ctx.agent.isNativeTarget = () => true;
      return fx;
    }],
    when: ["requesting composer control", async (fx) => {
      let error;
      try { await clearPaneComposer(fx.ctx, "target", 0, opts(fx)); }
      catch (caught) { error = caught; }
      return { fx, error };
    }],
    then: ["the tmux-only boundary is explicit", ({ fx, error }) => {
      expect(error.message).toContain("only for tmux fallback panes");
      expect(fx.tmuxCalls).toEqual([]);
      expect(fx.events).toEqual([]);
      expect(fx.mirrors).toEqual([]);
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });

  unit("the pre-existing esc command keeps its native adapter path", {
    given: ["a native runtime pane", () => {
      const fx = fixture({ discord: false });
      fx.ctx.agent.isNativeTarget = () => true;
      fx.ctx.agent.sendEscape = vi.fn(async () => {});
      fx.output = vi.spyOn(console, "log").mockImplementation(() => {});
      return fx;
    }],
    when: ["dispatching esc", async (fx) => {
      await dispatch(["esc", "target", "-p", "0"], fx.ctx);
      return fx;
    }],
    then: ["the native adapter remains authoritative", (fx) => {
      expect(fx.ctx.agent.sendEscape).toHaveBeenCalledWith("target", 0);
      expect(fx.tmuxCalls).toEqual([]);
      fx.output.mockRestore();
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });

  unit("amux enter routes exactly one Enter and appends real ledger receipts", {
    given: ["an isolated CLI environment", () => {
      const fx = fixture({ discord: false });
      fx.eventsPath = join(fx.root, "events.jsonl");
      fx.oldEventsPath = process.env.AMUX_EVENTS_PATH;
      process.env.AMUX_EVENTS_PATH = fx.eventsPath;
      fx.output = vi.spyOn(console, "log").mockImplementation(() => {});
      return fx;
    }],
    when: ["dispatching enter", async (fx) => {
      await dispatch(["enter", "target", "-p", "0"], fx.ctx);
      return fx;
    }],
    then: ["the CLI and ledger agree", (fx) => {
      expect(fx.tmuxCalls).toEqual(["send-keys -t 'target:.0' Enter"]);
      const rows = readFileSync(fx.eventsPath, "utf8")
        .trim()
        .split("\n")
        .map((line) => JSON.parse(line));
      expect(rows.map((row) => [row.event, row.action, row.keys])).toEqual([
        ["composer_control_requested", "enter", ["Enter"]],
        ["composer_control_sent", "enter", ["Enter"]],
      ]);
      expect(fx.output.mock.calls.flat().join(" ")).toContain("Sent Enter");
      fx.output.mockRestore();
      if (fx.oldEventsPath === undefined) delete process.env.AMUX_EVENTS_PATH;
      else process.env.AMUX_EVENTS_PATH = fx.oldEventsPath;
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });
});
