import { expect, feature, unit } from "bdd-vitest";
import { createPaneReplyReader } from "../core/pane-latest-reply.mjs";
import { createVoiceInput } from "./voice-input.mjs";

const AGENTS = { sandman: { discord: { "chan-0": 0, "chan-1": 1, "chan-2": 2 }, panes: [{}, {}, {}] } };

/** Pane 1 has replied twice, pane 0 once, pane 2 never; read through the real by-name reader. */
const paneReply = createPaneReplyReader("/fake/agents.yaml", {
  loadAgents: () => [{ name: "sandman", dir: "/fake/sandman", panes: [{}, {}, {}] }],
  readTurns: (_agent, pane) => ({
    0: { turns: [{ items: [{ type: "text", content: "Fel panels svar" }] }] },
    1: { turns: [{ items: [{ type: "text", content: "Äldre svar" }] }, { items: [{ type: "text", content: "Står Ghostwaker i AMUX?" }] }] },
  })[pane] || null,
});

function phoneInput() {
  const runs = [];
  const input = createVoiceInput({
    audioDiscovery: { target: "chan-0" }, audioOutbox: {}, deliveryBroker: { enqueue: () => {} },
    findChannelIdForPane: () => null, json: (_res, status, payload) => ({ status, payload }),
    loadAgents: () => AGENTS, parseJsonBody: async (req) => req.body, paneReply,
    run: async (command, timeoutMs, env) => { runs.push(env || {}); return { stdout: "Ghostwaker" }; },
    transcribeScript: "/fake/transcribe.sh",
  });
  return { input, runs };
}

feature("phone PTT is transcribed with its pane's latest reply as context", () => {
  for (const [channel, expected] of [["chan-1", "Står Ghostwaker i AMUX?"], ["chan-2", undefined]]) {
    unit(`PTT to ${channel} ${expected ? "carries that pane's reply" : "has no V1D_CONTEXT, since the pane has no reply"}`, {
      given: ["a phone turn to the pane", () => phoneInput()],
      when: ["the phone posts its audio", async (ctx) => ctx.input.phone(
        { body: { audio: Buffer.from("VOICE").toString("base64"), audioTarget: channel, idempotencyKey: "turn-1" } }, {})],
      then: ["the transcriber's environment holds exactly that reply", (result, ctx) => {
        expect(result.status).toBe(200);
        expect(ctx.runs[0].V1D_CONTEXT).toBe(expected);
        if (!expected) expect(Object.hasOwn(ctx.runs[0], "V1D_CONTEXT")).toBe(false);
      }],
    });
  }
});
