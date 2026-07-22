// Slash-ingest guard: the 2026-07-22 /compat incident contract. A durable
// /compact reached the Codex composer as /compat, the warn-only draft check
// submitted it anyway, and the engine's "Unrecognized command" reply fed a
// false stuck-composer rescue: 24 retries in 34 minutes until manual cancel.
// These tests pin the three stops (pre-submit echo veto, terminal rejection
// closure, composer ownership) plus zero duplicate submits across restarts.

import { feature, component, unit, expect } from "bdd-vitest";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  classifyCodexSlashEcho,
  detectSlashTerminalRejection,
  isShortSlashCommand,
  needsZoomFallback,
  waitForExactCodexDraftEcho,
} from "./slash-ingest-guard.mjs";
import { sendSlashVerified } from "./delivery.mjs";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { createDeliveryBroker } from "./delivery-broker.mjs";

const tempRoot = () => join(tmpdir(), `amux-slash-guard-${process.pid}-${Math.random().toString(36).slice(2)}`);

// Minimal Codex screen: glyph line + effort footer, matching codexComposerText.
const codexScreen = (composer) => [
  "codex",
  "",
  `› ${composer}`,
  "  gpt-5.1 high · 92% context left",
].join("\n");

// The incident tail: the refusal line echoes the needle as a suggestion.
const rejectionTail = [
  "• Working (3s)",
  "",
  "✖ Unrecognized command: /compat. Did you mean /compact?",
  "",
  "› ",
  "  gpt-5.1 high · 92% context left",
].join("\n");

function rejectingAgent(tail) {
  const sends = [];
  const enters = [];
  return {
    sends,
    enters,
    dismissBlockingPrompt: async () => null,
    sendOnly: async (_name, text, _pane, options = {}) => {
      sends.push(text);
      await options.onPasteStarted?.();
      await options.onDrafted?.();
      await options.onSubmitting?.();
      await options.onSubmitted?.();
      return { submitted: true };
    },
    sendEnter: async () => { enters.push("enter"); },
    capturePane: async () => tail,
  };
}

feature("classifyCodexSlashEcho: hard pre-submit echo gate", () => {
  component("a torn /compact echo (/compat) is blocked before submit", {
    given: ["a composer that dropped one byte during the paste", () => ({
      prompt: "/compact",
      snapshot: codexScreen("/compat"),
      entered: [],
    })],
    when: ["running the exact pre-submit sequence from sendPrompt", async (ctx) => {
      const exactDraft = await waitForExactCodexDraftEcho({
        prompt: ctx.prompt,
        captureScreen: async () => ctx.snapshot,
        sleep: async () => {},
        timeoutMs: 0,
      });
      const echo = classifyCodexSlashEcho({ prompt: ctx.prompt, snapshot: ctx.snapshot });
      if (exactDraft || !echo.blocked) ctx.entered.push("Enter");
      return { exactDraft, echo, entered: ctx.entered };
    }],
    then: ["the mismatch vetoes Enter with a classified reason", ({ exactDraft, echo, entered }) => {
      expect(exactDraft).toBe(false);
      expect(echo.blocked).toBe(true);
      expect(echo.kind).toBe("echo-mismatch");
      expect(echo.reason).toContain('"/compat"');
      expect(echo.reason).toContain('"/compact"');
      expect(entered).toEqual([]);
    }],
  });

  component("an unknown foreign draft is preserved untouched", {
    given: ["a composer holding prose the delivery never wrote", () => ({
      prompt: "/compact",
      prose: codexScreen("standup notes for tomorrow"),
      otherCommand: codexScreen("/clear"),
    })],
    when: ["classifying both foreign shapes", (ctx) => ({
      prose: classifyCodexSlashEcho({ prompt: ctx.prompt, snapshot: ctx.prose }),
      otherCommand: classifyCodexSlashEcho({ prompt: ctx.prompt, snapshot: ctx.otherCommand }),
    })],
    then: ["both park the attempt as foreign with no ownership claim", ({ prose, otherCommand }) => {
      expect(prose).toMatchObject({ blocked: true, kind: "foreign" });
      expect(prose.reason).toContain("foreign text left untouched");
      expect(otherCommand).toMatchObject({ blocked: true, kind: "foreign" });
    }],
  });

  component("unverifiable and matching composers never veto", {
    given: ["hidden, empty, and exact composer frames", () => ({
      prompt: "/compact",
      hidden: "codex transcript\n• Working on it\n  no composer glyph here",
      empty: codexScreen(""),
      exact: codexScreen("/compact"),
    })],
    when: ["classifying each frame", (ctx) => ({
      hidden: classifyCodexSlashEcho({ prompt: ctx.prompt, snapshot: ctx.hidden }),
      empty: classifyCodexSlashEcho({ prompt: ctx.prompt, snapshot: ctx.empty }),
      exact: classifyCodexSlashEcho({ prompt: ctx.prompt, snapshot: ctx.exact }),
    })],
    then: ["only a proven non-empty mismatch may block", ({ hidden, empty, exact }) => {
      expect(hidden).toEqual({ blocked: false, kind: "unverifiable" });
      expect(empty).toEqual({ blocked: false, kind: "unverifiable" });
      expect(exact).toEqual({ blocked: false, kind: "match" });
    }],
  });

  unit("only short slash commands are guarded", {
    given: ["commands, paths, prose, and an overlong payload", () => [
      "/compact", "/model fable", "/home/adelost/file.txt", "vanlig prompt", `/${"a".repeat(200)}`,
    ]],
    when: ["classifying payload shapes", (xs) => xs.map(isShortSlashCommand)],
    then: ["paths and prose stay on the legacy warn-only path", (r) =>
      expect(r).toEqual([true, true, false, false, false])],
  });
});

feature("detectSlashTerminalRejection: explicit engine refusal", () => {
  component("the incident refusal line is classified not-ingested", {
    given: ["the pane tail right after the corrupted submit", () => rejectionTail],
    when: ["scanning for an engine rejection", (tail) =>
      detectSlashTerminalRejection(tail, "/compact")],
    then: ["the refusal is terminal proof, not a stuck composer", (hit) => {
      expect(hit.rejected).toBe(true);
      expect(hit.reason).toContain("not-ingested");
      expect(hit.line).toContain("Unrecognized command");
    }],
  });

  component("a cleanly consumed command shows no rejection", {
    given: ["a tail where /compact executed", () => [
      "✓ Compacted 12k tokens",
      "",
      "› ",
      "  gpt-5.1 high · 92% context left",
    ].join("\n")],
    when: ["scanning", (tail) => detectSlashTerminalRejection(tail, "/compact")],
    then: ["no false rejection", (hit) => expect(hit).toBeNull()],
  });

  component("a rejection scrolled past the window is not ours", {
    given: ["an old refusal buried under newer output", () => [
      "✖ Unrecognized command: /compat",
      "• turn completed",
      "• another reply",
      "• more output",
      "• even more",
      "› ",
      "  gpt-5.1 high · 92% context left",
    ].join("\n")],
    when: ["scanning", (tail) => detectSlashTerminalRejection(tail, "/compact")],
    then: ["stale scrollback cannot close a fresh attempt", (hit) => expect(hit).toBeNull()],
  });
});

feature("slash delivery with the rejection classifier", () => {
  component("a terminal rejection closes the attempt without any rescue Enter", {
    given: ["an agent whose engine refuses the submitted command", () =>
      rejectingAgent(rejectionTail)],
    when: ["delivering /compact", async (agent) => ({
      result: await sendSlashVerified(agent, "claw", 1, "/compact",
        { settleMs: 0, sleep: async () => {} }),
      agent,
    })],
    then: ["one submit, zero blind retries, classified failure", ({ result, agent }) => {
      expect(result.delivered).toBe(false);
      expect(result.failed).toBe("not-ingested");
      expect(result.reason).toContain("engine rejected");
      expect(agent.sends).toEqual(["/compact"]);
      expect(agent.enters).toEqual([]);
    }],
  });

  component("a consumed command still verifies delivered through the same loop", {
    given: ["an agent whose composer consumes /compact cleanly", () =>
      rejectingAgent("✓ Compacted 12k tokens\n\n› \n")],
    when: ["delivering", async (agent) => ({
      result: await sendSlashVerified(agent, "claw", 1, "/compact",
        { settleMs: 0, sleep: async () => {} }),
      agent,
    })],
    then: ["the fail-open success path is preserved", ({ result, agent }) => {
      expect(result).toEqual({ delivered: true, rescues: 0 });
      expect(agent.enters).toEqual([]);
    }],
  });

  component("a pre-submit echo block propagates without rescue Enter", {
    given: ["an agent blocked by the hard echo gate", () => {
      const agent = rejectingAgent("unreachable");
      agent.sendOnly = async () => {
        agent.sends.push("blocked-send");
        const error = new Error('Codex slash echo mismatch: composer shows "/compat"');
        error.code = "AMUX_DELIVERY_BLOCKED";
        throw error;
      };
      return agent;
    }],
    when: ["delivering /compact", async (agent) => ({
      error: await sendSlashVerified(agent, "claw", 1, "/compact",
        { settleMs: 0, sleep: async () => {} }).catch((err) => err),
      agent,
    })],
    then: ["the classified block reaches the broker and no Enter follows", ({ error, agent }) => {
      expect(error).toMatchObject({ code: "AMUX_DELIVERY_BLOCKED" });
      expect(error.message).toContain("echo mismatch");
      expect(agent.enters).toEqual([]);
    }],
  });
});

feature("broker closure and restart safety", () => {
  component("an engine-rejected slash job ends terminal and never resubmits after restart", {
    given: ["a durable /compact job and a rejecting pane", () => {
      const rootDir = tempRoot();
      mkdirSync(rootDir, { recursive: true });
      const queue = createDeliveryQueue({ rootDir });
      const job = queue.enqueue({ agentName: "ai", pane: 5, text: "/compact" });
      const notices = [];
      const agent = rejectingAgent(rejectionTail);
      const broker = createDeliveryBroker({
        agent,
        queue,
        notify: async (_job, kind) => { notices.push(kind); },
      });
      return { rootDir, queue, job, notices, agent, broker };
    }],
    when: ["the job drains, the loop restarts on the same spool, and it drains again", async (ctx) => {
      await ctx.broker.kickTarget("ai", 5);
      const afterReject = ctx.queue.read("ai", 5, ctx.job.id);
      // Loop restart: a fresh queue and broker over the same durable spool.
      const queue2 = createDeliveryQueue({ rootDir: ctx.rootDir });
      const agent2 = rejectingAgent(rejectionTail);
      const broker2 = createDeliveryBroker({
        agent: agent2,
        queue: queue2,
        notify: async () => {},
      });
      await broker2.kickTarget("ai", 5);
      await ctx.broker.kickTarget("ai", 5);
      return { afterReject, agent2, restarted: queue2.read("ai", 5, ctx.job.id) };
    }],
    then: ["exactly one submit ever, terminal NOT SENT, zero duplicate submits", ({ afterReject, agent2, restarted }, ctx) => {
      expect(afterReject).toMatchObject({
        status: "cancelled",
        nextAttemptAt: null,
        terminalAt: expect.any(Number),
      });
      expect(afterReject.metadata).toMatchObject({
        deliveryOutcome: "not-sent",
        deliveryRejection: "engine-rejected",
      });
      expect(afterReject.lastReason).toContain("not sent: engine rejected");
      expect(ctx.notices).toEqual(["not-sent"]);
      expect(ctx.agent.sends).toEqual(["/compact"]);
      expect(ctx.agent.enters).toEqual([]);
      expect(agent2.sends).toEqual([]);
      expect(agent2.enters).toEqual([]);
      expect(restarted.status).toBe("cancelled");
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  unit("zoom fallback still only earns one re-read on paint-shaped failures", {
    given: ["blocked, submitted, and plain results", () => [
      { zoomRecoverable: true, delivered: false },
      { zoomRecoverable: true, delivered: false },
      { zoomRecoverable: false, delivered: false },
    ]],
    when: ["judging zoom eligibility", (results) => [
      needsZoomFallback(results[0], false),
      needsZoomFallback(results[1], true),
      needsZoomFallback(results[2], false),
    ]],
    then: ["only an unsubmitted zoom-recoverable failure zooms", (r) =>
      expect(r).toEqual([true, false, false])],
  });
});
