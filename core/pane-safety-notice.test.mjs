// A refused pane start must reach the human who sent the message. The broker
// records an ensureReady failure as `wake-refused:<message>`; the Discord
// slash reply and the waiting notice both read that reason.

import { feature, unit, expect } from "bdd-vitest";
import { slashQueueReply } from "./delivery.mjs";
import { plainReason } from "./delivery-notice-copy.mjs";
import { countPanes } from "./pane-provisioning.mjs";
import { createEngineStartGuard } from "./engine-start-guard.mjs";

const brokerResult = (error) => ({ delivered: false, pending: true, reason: `wake-refused:${error.message}` });

async function twinRefusal() {
  const tmux = { paneRows: async () => [
    { index: 2, id: "%58", dead: false, command: "bash", path: "/repo/.agents/2" },
    { index: 10, id: "%23", dead: false, command: "claude", path: "/repo/.agents/2" },
  ] };
  const guard = createEngineStartGuard({ tmux, wait: async () => {}, log: () => {} });
  return guard({ session: "skyvw", pane: 2, dir: "/repo/.agents/2" }).catch((error) => error);
}

async function countRefusal() {
  const tmux = { paneCount: async () => { throw new Error("timed out after 3000 ms"); } };
  return countPanes(tmux, "skyvw").catch((error) => error);
}

feature("pane safety refusals in Discord replies", () => {
  unit("a /compact refused as a duplicate start says so", {
    given: ["the broker result of a wake refused by the engine start guard", async () => brokerResult(await twinRefusal())],
    when: ["replying to the slash command", (result) => ({ reply: slashQueueReply("/compact", result), notice: plainReason(result.reason) })],
    then: ["the reply names the live pane and the notice names the duplicate", ({ reply, notice }) => {
      expect(reply).toContain("`/compact` is queued but its pane was not started");
      expect(reply).toContain("skyvw:10 (%23, claude) already runs from /repo/.agents/2");
      expect(notice).toBe("panelens session kör redan i en annan process eller panel, så amux startar den inte en gång till");
    }],
  });

  unit("an unknown pane count says so", {
    given: ["the broker result of a wake refused on a failed pane count", async () => brokerResult(await countRefusal())],
    when: ["replying to the slash command", (result) => ({ reply: slashQueueReply("/compact", result), notice: plainReason(result.reason) })],
    then: ["the reply and the notice name the unsafe layout", ({ reply, notice }) => {
      expect(reply).toContain("pane layout unsafe: cannot count panes in 'skyvw' (timed out after 3000 ms)");
      expect(notice).toBe("amux kan inte lita på panelernas numrering i tmux just nu, så inget startas eller läggs till");
    }],
  });

  unit("an ordinary durable queue keeps its short reply", {
    given: ["a pending result with a receipt wait", () => ({ delivered: false, pending: true, reason: "awaiting exact command receipt" })],
    when: ["replying to the slash command", (result) => slashQueueReply("/compact", result)],
    then: ["queued durably", (reply) => expect(reply).toBe("queued durably `/compact`")],
  });
});
