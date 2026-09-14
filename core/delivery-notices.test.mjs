import { expect, feature, unit } from "bdd-vitest";
import { blockedDeliveryNotice, createDiscordDeliveryNotify } from "./delivery-notices.mjs";

const recordingDiscord = () => {
  const sent = [];
  return { sent, send: async (channelId, text) => { sent.push({ channelId, text }); } };
};

feature("durable delivery notice copy", () => {
  unit("a memory-refused Claude wake is never mislabeled as Codex", {
    when: ["rendering the persisted refusal", () => blockedDeliveryNotice({
      lastReason: "wake-refused:memory-critical",
    })],
    then: ["the real blocker is named without inventing an engine", (notice) => {
      expect(notice).toContain("kritisk minnespress");
      expect(notice).toContain("säkert köat");
      expect(notice).not.toMatch(/Codex|Claude|composer/u);
    }],
  });

  unit("identity and unknown refusals stay honest and actionable", {
    then: ["each reason has bounded engine-neutral copy", () => {
      expect(blockedDeliveryNotice({ lastReason: "wake-refused:identity-package-content" }))
        .toContain("release-identiteten");
      expect(blockedDeliveryNotice({ lastReason: "probe unavailable" }))
        .toContain("inte redo för säker leverans");
    }],
  });

  unit("a notice for a pane without a bound channel fails so the broker retries it", {
    given: ["a Discord adapter and no channel for the pane", () => recordingDiscord()],
    when: ["notifying a blocked job", (discord) => createDiscordDeliveryNotify({
      discord, resolveChannel: () => null,
    })({ agentName: "lsrc", pane: 3, lastReason: "memory-blocked" }, "blocked")
      .then(() => null, (error) => ({ error, discord }))],
    then: ["nothing is posted and the failure names the pane", (result) => {
      expect(result.error.message).toContain("lsrc:3");
      expect(result.discord.sent).toEqual([]);
    }],
  });

  unit("the job's recorded channel wins and an unknown state posts nothing", {
    given: ["a Discord adapter whose lookup would pick another channel", () => recordingDiscord()],
    when: ["notifying stalled and an unknown state", async (discord) => {
      const notify = createDiscordDeliveryNotify({ discord, resolveChannel: () => "looked-up" });
      const job = { agentName: "lsrc", pane: 1, metadata: { channelId: "recorded" } };
      await notify(job, "stalled", { queuedBehind: 2 });
      await notify(job, "no-such-state");
      return discord.sent;
    }],
    then: ["one stalled notice lands in the recorded channel", (sent) => {
      expect(sent.map((entry) => entry.channelId)).toEqual(["recorded"]);
      expect(sent[0].text).toContain("2 meddelande(n) väntar");
    }],
  });
});
