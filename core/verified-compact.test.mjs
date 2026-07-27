import { expect, feature, unit } from "bdd-vitest";
import { verifiedClaudeCompact } from "./verified-compact.mjs";

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
