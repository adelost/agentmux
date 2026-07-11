import { feature, unit, expect } from "bdd-vitest";
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

feature("sendToPane delivery outcome", () => {
  unit("verified delivery is returned to the caller", {
    given: ["an unparked pane", () => {
      const path = tmpPath();
      writeFileSync(path, "");
      const oldPath = process.env.AMUX_PARK_STATE_PATH;
      process.env.AMUX_PARK_STATE_PATH = path;
      return { path, oldPath, agent: fakeAgent() };
    }],
    when: ["sending", async ({ path, oldPath, agent }) => {
      const result = await sendToPane({ agent, configPath: null }, "claw", 1, "review this");
      if (oldPath === undefined) delete process.env.AMUX_PARK_STATE_PATH;
      else process.env.AMUX_PARK_STATE_PATH = oldPath;
      try { unlinkSync(path); } catch {}
      return { result, sent: agent.sent };
    }],
    then: ["the result is explicit and the prompt was sent once", ({ result, sent }) => {
      expect(result).toMatchObject({ delivered: true, blocked: false, via: "echo" });
      expect(sent).toEqual(["review this"]);
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
});
