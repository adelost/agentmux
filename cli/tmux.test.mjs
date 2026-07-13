import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { unlinkSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { sendToPane } from "./tmux.mjs";
import { parkPane } from "../core/pane-park.mjs";

const tmpPath = () => join(tmpdir(), `amux-send-test-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);

function fakeAgent() {
  const sent = [];
  return {
    sent,
    dismissBlockingPrompt: async () => null,
    sendOnly: async (_name, text) => { sent.push(text); },
    waitForPromptEcho: async () => true,
    isBusy: async () => false,
  };
}

function fakeDeliveryQueue(status = "acknowledged") {
  let job = null;
  return {
    enqueue: vi.fn((request) => {
      job = { id: "job-1", status: "pending", ...request };
      return job;
    }),
    findById: vi.fn(() => job ? { ...job, status } : null),
  };
}

feature("sendToPane delivery outcome", () => {
  unit("verified delivery is returned to the caller", {
    given: ["an unparked pane", () => {
      const path = tmpPath();
      writeFileSync(path, "");
      const oldPath = process.env.AMUX_PARK_STATE_PATH;
      process.env.AMUX_PARK_STATE_PATH = path;
      return { path, oldPath, agent: fakeAgent(), deliveryQueue: fakeDeliveryQueue() };
    }],
    when: ["sending", async ({ path, oldPath, agent, deliveryQueue }) => {
      const result = await sendToPane({ agent, configPath: null, deliveryQueue, deliveryWaitMs: 0 }, "claw", 1, "review this");
      if (oldPath === undefined) delete process.env.AMUX_PARK_STATE_PATH;
      else process.env.AMUX_PARK_STATE_PATH = oldPath;
      try { unlinkSync(path); } catch {}
      return { result, sent: agent.sent };
    }],
    then: ["the result is explicit and tmux is left to the broker", ({ result, sent }) => {
      expect(result).toMatchObject({ delivered: true, blocked: false, via: "broker" });
      expect(sent).toEqual([]);
    }],
  });

  unit("park guard returns blocked without touching the pane", {
    given: ["a parked pane", () => {
      const path = tmpPath();
      parkPane({ session: "claw", pane: 1, detail: "sol to luna", path });
      const oldPath = process.env.AMUX_PARK_STATE_PATH;
      process.env.AMUX_PARK_STATE_PATH = path;
      return { path, oldPath, agent: fakeAgent() };
    }],
    when: ["sending work", async ({ path, oldPath, agent }) => {
      const result = await sendToPane({ agent, configPath: null }, "claw", 1, "review this");
      if (oldPath === undefined) delete process.env.AMUX_PARK_STATE_PATH;
      else process.env.AMUX_PARK_STATE_PATH = oldPath;
      try { unlinkSync(path); } catch {}
      return { result, sent: agent.sent };
    }],
    then: ["the caller can fail loudly and no prompt was injected", ({ result, sent }) => {
      expect(result).toMatchObject({ delivered: false, blocked: true });
      expect(sent).toEqual([]);
    }],
  });

  unit("returns a durable pending receipt while the broker has not acknowledged", {
    given: ["an unparked pane whose queued job is still pending", () => {
      const path = tmpPath();
      writeFileSync(path, "");
      const oldPath = process.env.AMUX_PARK_STATE_PATH;
      process.env.AMUX_PARK_STATE_PATH = path;
      const agent = fakeAgent();
      return { path, oldPath, agent, deliveryQueue: fakeDeliveryQueue("drafted") };
    }],
    when: ["sending through the CLI delivery contract", async ({ path, oldPath, agent, deliveryQueue }) => {
      const result = await sendToPane(
        { agent, configPath: null, deliveryQueue, deliveryWaitMs: 0 },
        "claw",
        3,
        "[from claw:0]\n\nclaim respected",
        { mirror: false },
      );
      if (oldPath === undefined) delete process.env.AMUX_PARK_STATE_PATH;
      else process.env.AMUX_PARK_STATE_PATH = oldPath;
      try { unlinkSync(path); } catch {}
      return result;
    }],
    then: ["the caller knows it is safely queued, not falsely failed", (result) => {
      expect(result).toMatchObject({ delivered: true, blocked: false, pending: true, queueState: "drafted" });
    }],
  });

  unit("cross-agent delivery mirrors the full brief to target and a receipt to sender", {
    given: ["a verified lsrc:4 to lsrc:0 brief with both panes bound", () => {
      const parkPath = tmpPath();
      const configPath = tmpPath();
      writeFileSync(parkPath, "");
      writeFileSync(configPath, [
        "lsrc:",
        "  dir: /tmp/lsrc",
        "  discord:",
        "    sender-channel: 4",
        "    target-channel: 0",
        "",
      ].join("\n"));
      const oldPath = process.env.AMUX_PARK_STATE_PATH;
      process.env.AMUX_PARK_STATE_PATH = parkPath;
      return { parkPath, configPath, oldPath, agent: fakeAgent(), deliveryQueue: fakeDeliveryQueue(), mirrors: [] };
    }],
    when: ["sending through the central delivery path", async (ctx) => {
      const result = await sendToPane(
        { agent: ctx.agent, configPath: ctx.configPath, deliveryQueue: ctx.deliveryQueue, deliveryWaitMs: 0 },
        "lsrc",
        0,
        "[from lsrc:4]\n\nreview every image",
        { mirrorDispatch: (payload) => ctx.mirrors.push(payload) },
      );
      if (ctx.oldPath === undefined) delete process.env.AMUX_PARK_STATE_PATH;
      else process.env.AMUX_PARK_STATE_PATH = ctx.oldPath;
      try { unlinkSync(ctx.parkPath); } catch {}
      try { unlinkSync(ctx.configPath); } catch {}
      return { result, mirrors: ctx.mirrors };
    }],
    then: ["target gets the brief and sender gets immediate delivery proof", ({ result, mirrors }) => {
      expect(result.delivered).toBe(true);
      expect(mirrors).toEqual([
        { channelId: "target-channel", content: "[from lsrc:4]\n\nreview every image" },
        { channelId: "sender-channel", content: "`amux lsrc -p 0 …` → delivered." },
      ]);
    }],
  });
});
