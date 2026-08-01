import { expect, feature, unit } from "bdd-vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { verifiedClaudeCompact, verifiedCodexCompact } from "./verified-compact.mjs";

feature("verified Claude compact", () => {
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
});
