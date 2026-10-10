import { expect, feature, unit } from "bdd-vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifiedClaudeCompact, verifiedCodexCompact } from "./verified-compact.mjs";
import { sendSlashVerified } from "./delivery.mjs";
import { captureJsonlAppendCursor } from "./jsonl-append-cursor.mjs";

feature("verified Claude compact", () => {
  unit("Not enough messages to compact ends the wait within one poll", {
    given: ["a journal where Claude answers the /compact with nothing to compact", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-empty-compact-"));
      const path = join(root, "session.jsonl");
      writeFileSync(path, `${JSON.stringify({ type: "user", timestamp: "2026-10-10T09:00:00.000Z" })}\n`);
      return { root, path };
    }],
    when: ["compacting with the full ten-minute budget", async ({ root, path }) => {
      let clock = Date.parse("2026-10-10T09:15:12.000Z"), sleeps = 0;
      const result = await verifiedClaudeCompact({
        agent: { capturePromptEchoCursor: async () => captureJsonlAppendCursor("claude-prompt-events-v1", [path]) },
        agentName: "api", pane: 2, paneDir: root,
        latestIdentity: () => ({ sessionId: "same-session" }), now: () => clock,
        sendSlash: async () => {
          appendFileSync(path, `${JSON.stringify({ type: "system", subtype: "local_command", commandRun: { command: "compact", args: "" },
            content: "<local-command-stdout>Not enough messages to compact.</local-command-stdout>",
            timestamp: new Date(clock + 14).toISOString() })}\n`);
          return { delivered: true, via: "command-receipt" };
        },
        hasBoundary: () => false,
        sleep: async (ms) => { sleeps += 1; clock += ms; },
      });
      rmSync(root, { recursive: true, force: true });
      return { result, sleeps };
    }],
    then: ["it returns at once as nothing to compact, not a missing boundary", ({ result, sleeps }) => {
      expect(result).toMatchObject({ ok: false, reason: "compact-nothing-to-compact", nothingToCompact: true,
        sessionId: "same-session" });
      expect(sleeps).toBeLessThanOrEqual(1);
    }],
  });

  unit("accepts the observed 145-second nightly receipt without another model call", {
    when: ["the command and boundary arrive later than the former two-minute wait", async () => {
      let clock = 1_000, submits = 0, rescues;
      const result = await verifiedClaudeCompact({
        agent: { capturePromptEchoCursor: async () => ({ positions: { journal: 10 } }) },
        agentName: "claw", pane: 2, paneDir: "/pane",
        latestIdentity: () => ({ sessionId: "same-session" }), now: () => clock,
        sendSlash: async (_agent, _name, _pane, _command, options) => {
          submits += 1;
          rescues = options.maxRescues;
          clock += Math.min(145_000, options.receiptTimeoutMs);
          return { delivered: options.receiptTimeoutMs >= 145_000, via: "command-receipt" };
        },
        hasBoundary: () => clock >= 146_000,
        sleep: async (ms) => { clock += ms; },
      });
      return { result, submits, rescues };
    }],
    then: ["one exact command and its boundary suffice", ({ result, submits, rescues }) => {
      expect(result.ok).toBe(true);
      expect(submits).toBe(1);
      expect(rescues).toBe(0);
    }],
  });

  // The wait is about twice the longest measured Claude compact (294 s of
  // 190, 2026-08-15 to 2026-10-02), so a long compact is not reported as
  // not run (Mattias 2026-10-02: "Detta borde inte hända igen").
  unit("shares a single ten-minute budget across command and missing boundary", {
    when: ["a nearly timed-out command has no matching journal boundary", async () => {
      let clock = 1_000;
      const result = await verifiedClaudeCompact({
        agent: { capturePromptEchoCursor: async () => ({ positions: { journal: 10 } }) },
        agentName: "claw", pane: 2, paneDir: "/pane",
        latestIdentity: () => ({ sessionId: "same-session" }), now: () => clock,
        sendSlash: async () => {
          clock += 599_000;
          return { delivered: true, via: "command-receipt" };
        },
        hasBoundary: () => false,
        sleep: async (ms) => { clock += ms; },
      });
      return { result, elapsed: clock - 1_000 };
    }],
    then: ["no success or second full wait is invented", ({ result, elapsed }) => {
      expect(result).toEqual({ ok: false, reason: "compact-boundary-missing" });
      expect(elapsed).toBeLessThanOrEqual(600_000);
    }],
  });

  unit("verifies a compact that runs longer than the former five-minute wait", {
    when: ["Claude writes its receipt and boundary after 400 seconds", async () => {
      let clock = 1_000;
      const result = await verifiedClaudeCompact({
        agent: { capturePromptEchoCursor: async () => ({ positions: { journal: 10 } }) },
        agentName: "lsrc", pane: 2, paneDir: "/pane",
        latestIdentity: () => ({ sessionId: "same-session" }), now: () => clock,
        sendSlash: async (_agent, _name, _pane, _command, options) => {
          clock += Math.min(400_000, options.receiptTimeoutMs);
          return { delivered: options.receiptTimeoutMs >= 400_000, via: "command-receipt" };
        },
        hasBoundary: () => clock >= 401_000,
        sleep: async (ms) => { clock += ms; },
      });
      return result;
    }],
    then: ["the compact is verified instead of reported as not run", (result) => {
      expect(result.ok).toBe(true);
    }],
  });

  unit("hands the pane back to other writers as soon as Enter is sent", {
    when: ["the compact command is submitted", async () => {
      const events = [];
      await verifiedClaudeCompact({
        agent: { capturePromptEchoCursor: async () => ({ positions: { journal: 10 } }) },
        agentName: "lsrc", pane: 2, paneDir: "/pane",
        latestIdentity: () => ({ sessionId: "same-session" }),
        sendSlash: async (_agent, _name, _pane, _command, options) => {
          await options.onSubmitted();
          events.push("receipt-wait");
          return { delivered: true, via: "command-receipt" };
        },
        hasBoundary: () => true,
        onCommandAccepted: () => events.push("accepted"),
        sleep: async () => {},
      });
      return events;
    }],
    then: ["the hook runs before the long receipt wait", (events) => {
      expect(events).toEqual(["accepted", "receipt-wait"]);
    }],
  });

  // lsrc:2, 2026-09-27: Claude journaled "You've hit your weekly limit" one
  // second after /compact, and the caller still waited five minutes.
  unit("stops at Claude's own refusal and keeps its words", {
    when: ["Claude journals a failed compact right after the submit", async () => {
      let clock = 1_000;
      const result = await verifiedClaudeCompact({
        agent: { capturePromptEchoCursor: async () => ({ positions: { journal: 10 } }) },
        agentName: "lsrc", pane: 2, paneDir: "/pane",
        latestIdentity: () => ({ sessionId: "same-session" }), now: () => clock,
        sendSlash: async () => ({ delivered: true, via: "command-receipt" }),
        hasBoundary: () => false,
        compactRefusal: () => "Error during compaction: You've hit your weekly limit · resets Sep 30, 9am (Europe/Stockholm)",
        sleep: async (ms) => { clock += ms; },
      });
      return { result, waited: clock - 1_000 };
    }],
    then: ["the attempt ends at once as a usage limit with the provider's text", ({ result, waited }) => {
      expect(result).toEqual({ ok: false, reason: "provider-usage-limited",
        detail: "Error during compaction: You've hit your weekly limit · resets Sep 30, 9am (Europe/Stockholm)" });
      expect(waited).toBe(0);
    }],
  });

  unit("waits for a delayed exact command receipt instead of rescuing Enter during compact", {
    when: ["Claude persists its compact receipt after the old 600ms cutoff", async () => {
      const calls = [];
      const result = await verifiedClaudeCompact({
        agent: {
          capturePromptEchoCursor: async () => ({ positions: { journal: 10 } }),
          captureSlashReceiptCursor: async () => ({ kind: "test-cursor", positions: { journal: 10 } }),
          dismissBlockingPrompt: async () => {},
          sendOnly: async () => calls.push("submit"),
          sendEnter: async () => calls.push("extra-enter"),
          waitForSlashReceipt: async (_a, _p, _c, timeout) => {
            calls.push(timeout);
            return timeout >= 1_000;
          },
        },
        agentName: "claw", pane: 2, paneDir: "/pane",
        latestIdentity: () => ({ sessionId: "same-session" }),
        hasBoundary: () => true, sendSlash: sendSlashVerified,
        sleep: async () => {}, pollAttempts: 2, pollMs: 1_000,
      });
      return { result, calls };
    }],
    then: ["the exact receipt and compact boundary authorize the same session without duplicate submit", ({ result, calls }) => {
      expect(result.ok).toBe(true);
      expect(calls).toEqual(["submit", 2_000]);
    }],
  });

  unit("requires command receipt, journal boundary, and unchanged exact session", {
    given: ["an idle pane with one persisted session", () => {
      const identity = { sessionId: "11111111-1111-4111-8111-111111111111" };
      return {
        identity,
        agent: {
          capturePromptEchoCursor: async () => ({ positions: { journal: 10 } }),
        },
      };
    }],
    when: ["compacting through the verified path", (ctx) => verifiedClaudeCompact({
      agent: ctx.agent,
      agentName: "lsrc",
      pane: 3,
      paneDir: "/pane",
      latestIdentity: () => ctx.identity,
      sendSlash: async () => ({ delivered: true, via: "command-receipt" }),
      hasBoundary: () => true,
      sleep: async () => {},
    })],
    then: ["the receipt binds the same native session", (result) => {
      expect(result).toMatchObject({
        ok: true,
        sessionId: "11111111-1111-4111-8111-111111111111",
        commandReceipt: "command-receipt",
        compactBoundary: true,
      });
    }],
  });

  unit("a changed session fails closed", {
    when: ["the journal identity changes while compacting", async () => {
      const identities = [
        { sessionId: "11111111-1111-4111-8111-111111111111" },
        { sessionId: "22222222-2222-4222-8222-222222222222" },
      ];
      return verifiedClaudeCompact({
        agent: { capturePromptEchoCursor: async () => ({ positions: { journal: 10 } }) },
        agentName: "lsrc",
        pane: 3,
        paneDir: "/pane",
        latestIdentity: () => identities.shift(),
        sendSlash: async () => ({ delivered: true, via: "command-receipt" }),
        hasBoundary: () => true,
        sleep: async () => {},
      });
    }],
    then: ["rotation is refused", (result) => {
      expect(result).toEqual({ ok: false, reason: "compact-session-changed" });
    }],
  });
});

feature("verified Codex compact", () => {
  unit("requires a new rollout compact event in the unchanged exact session", {
    given: ["one append-only pane rollout", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-codex-compact-"));
      const path = join(root, "rollout.jsonl");
      writeFileSync(path, `${JSON.stringify({ type: "session_meta" })}\n`);
      return {
        root,
        path,
        identity: { sessionId: "11111111-1111-4111-8111-111111111111", path },
      };
    }],
    when: ["compacting through the rollout boundary", async (ctx) => ({
      ...ctx,
      result: await verifiedCodexCompact({
        agent: {}, agentName: "claw", pane: 3, paneDir: "/pane",
        latestIdentity: () => ctx.identity,
        sendSlash: async () => {
          appendFileSync(ctx.path, `${JSON.stringify({ type: "compacted", payload: {} })}\n`);
          return { delivered: true };
        },
        sleep: async () => {}, pollAttempts: 1,
      }),
    })],
    then: ["the receipt binds the rollout event and session", ({ root, result }) => {
      expect(result).toMatchObject({
        ok: true,
        sessionId: "11111111-1111-4111-8111-111111111111",
        commandReceipt: "codex-compact-boundary",
        compactBoundary: true,
      });
      rmSync(root, { recursive: true, force: true });
    }],
  });

  // lsrc:3, 2026-10-02: the compact started 09:01:21 and finished 09:09:44,
  // but the 180-poll wait reported it as not run at 09:04:51.
  unit("verifies a compact that runs past three minutes", {
    given: ["a rollout whose compact turn has started", () => codexRollout()],
    when: ["the compaction lands 503 seconds later", async (ctx) => {
      let polls = 0, accepted = 0;
      const result = await verifiedCodexCompact({
        agent: {}, agentName: "lsrc", pane: 3, paneDir: "/pane",
        latestIdentity: () => ctx.identity,
        sendSlash: async () => {
          ctx.append({ type: "event_msg", payload: { type: "task_started" } });
          return { delivered: true };
        },
        onCommandAccepted: () => { accepted += 1; },
        sleep: async () => {
          polls += 1;
          if (polls === 503) {
            ctx.append({ type: "compacted", payload: {} });
            ctx.append({ type: "event_msg", payload: { type: "context_compacted" } });
            ctx.append({ type: "event_msg", payload: { type: "task_complete" } });
          }
        },
      });
      return { ...ctx, result, accepted };
    }],
    then: ["the compact is verified and the pane was handed back once", ({ root, result, accepted }) => {
      expect(result.ok).toBe(true);
      expect(accepted).toBe(1);
      rmSync(root, { recursive: true, force: true });
    }],
  });

  unit("a compact turn that closes without compacting fails at once", {
    given: ["a rollout whose compact turn has started", () => codexRollout()],
    when: ["Codex closes the turn with no compaction", async (ctx) => {
      let polls = 0;
      const result = await verifiedCodexCompact({
        agent: {}, agentName: "lsrc", pane: 3, paneDir: "/pane",
        latestIdentity: () => ctx.identity,
        sendSlash: async () => {
          ctx.append({ type: "event_msg", payload: { type: "task_started" } });
          ctx.append({ type: "event_msg", payload: { type: "task_complete" } });
          return { delivered: true };
        },
        sleep: async () => { polls += 1; },
      });
      return { ...ctx, result, polls };
    }],
    then: ["it is reported as not run without waiting out the budget", ({ root, result, polls }) => {
      expect(result).toEqual({ ok: false, reason: "compact-ended-without-boundary" });
      expect(polls).toBe(0);
      rmSync(root, { recursive: true, force: true });
    }],
  });
});

function codexRollout() {
  const root = mkdtempSync(join(tmpdir(), "amux-codex-compact-"));
  const path = join(root, "rollout.jsonl");
  writeFileSync(path, `${JSON.stringify({ type: "session_meta" })}\n`);
  return {
    root,
    identity: { sessionId: "11111111-1111-4111-8111-111111111111", path },
    append: (event) => appendFileSync(path, `${JSON.stringify(event)}\n`),
  };
}
