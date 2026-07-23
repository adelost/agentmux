// Kimi status truth: the skydive:10 incident, pinned. A Kimi pane mid-turn
// in a quiet thinking phase showed "unknown" in amux ps because the screen
// parser does not know the "K3 thinking" footer and the generic mtime
// overlay looks in the pane dir while the Wire journal lives in the Kimi
// home. Delivery's isBusy reads the same Wire source, so ps now agrees.

import { expect, feature, component } from "bdd-vitest";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { detectPaneStatus } from "../cli/format.mjs";
import { isBusyFromKimiJsonl } from "./kimi-jsonl-reader.mjs";
import { kimiObservedStatus } from "./kimi-status-truth.mjs";

const root = () => join(tmpdir(), `amux-kimi-status-${process.pid}-${Math.random().toString(36).slice(2)}`);

// A frozen skydive:10 frame: thinking footer, no Claude/Codex working anchor.
const FROZEN_THINKING = [
  "  some earlier answer text",
  "",
  "⠦ thinking...",
  "K3 thinking: max",
  "> ",
].join("\n");

function harness(wireEvents) {
  const home = root();
  const paneDir = join(home, "pane");
  const sessionDir = join(home, "sessions", "wd_1_abc", "session_9b1f2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d");
  mkdirSync(join(sessionDir, "agents", "main"), { recursive: true });
  mkdirSync(paneDir, { recursive: true });
  writeFileSync(
    join(home, "session_index.jsonl"),
    `${JSON.stringify({
      sessionId: "session_9b1f2c3d-4e5f-6a7b-8c9d-0e1f2a3b4c5d",
      sessionDir,
      workDir: paneDir,
    })}\n`,
  );
  writeFileSync(
    join(sessionDir, "agents", "main", "wire.jsonl"),
    wireEvents.map((event) => JSON.stringify(event)).join("\n") + "\n",
  );
  return { home, paneDir, options: { env: { KIMI_CODE_HOME: home } } };
}

const BUSY_WIRE = [
  { type: "turn.prompt", prompt: "skriv om modulen" },
  { type: "context.append_loop_event", event: { type: "step.begin" } },
];

const DONE_WIRE = [
  { type: "turn.prompt", prompt: "skriv om modulen" },
  { type: "context.append_loop_event", event: { type: "step.begin" } },
  { type: "context.append_loop_event", event: { type: "step.end", finishReason: "end_turn" } },
];

feature("kimi observed status: one busy truth for ps and delivery", () => {
  component("a quiet thinking phase reports working from the journal, not the screen", {
    given: ["a frozen thinking frame and a busy Wire journal", () => harness(BUSY_WIRE)],
    when: ["reading the screen status and the observed status", (ctx) => ({
      screen: detectPaneStatus(FROZEN_THINKING),
      observed: kimiObservedStatus(detectPaneStatus(FROZEN_THINKING), ctx.paneDir, ctx.options),
      delivery: isBusyFromKimiJsonl(ctx.paneDir, ctx.options),
      cleanup: () => rmSync(ctx.home, { recursive: true, force: true }),
    })],
    then: ["the screen fails as in the incident, the journal truth agrees with delivery", (r) => {
      expect(r.screen).not.toBe("working"); // the genuine incident failure, proven
      expect(r.delivery).toBe(true);
      expect(r.observed).toBe("working");
      r.cleanup();
    }],
  });

  component("an identical frozen frame after a done journal is not working", {
    given: ["the same frame but a completed Wire journal", () => harness(DONE_WIRE)],
    when: ["reading both truths", (ctx) => ({
      observed: kimiObservedStatus(detectPaneStatus(FROZEN_THINKING), ctx.paneDir, ctx.options),
      delivery: isBusyFromKimiJsonl(ctx.paneDir, ctx.options),
      cleanup: () => rmSync(ctx.home, { recursive: true, force: true }),
    })],
    then: ["frozen scrollback never becomes permanent working", (r) => {
      expect(r.delivery).toBe(false);
      expect(r.observed).not.toBe("working");
      r.cleanup();
    }],
  });

  component("screen modals always win over the journal upgrade", {
    given: ["a busy journal but a permission-shaped screen", () => harness(BUSY_WIRE)],
    when: ["observing a non-idle screen status", (ctx) => ({
      observed: kimiObservedStatus("permission", ctx.paneDir, ctx.options),
      cleanup: () => rmSync(ctx.home, { recursive: true, force: true }),
    })],
    then: ["the journal never shadows a real modal", (r) => {
      expect(r.observed).toBe("permission");
      r.cleanup();
    }],
  });
});
