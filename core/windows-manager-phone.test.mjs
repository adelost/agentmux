import { component, expect, feature } from "bdd-vitest";
import { createWindowsManagerPhoneServer } from "./windows-manager-phone.mjs";

async function post(url, body) {
  const response = await fetch(`${url}/api/audio/send`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  return { status: response.status, body: await response.json() };
}

function setup(overrides = {}) {
  const state = {};
  const saves = [];
  const turns = [];
  const server = createWindowsManagerPhoneServer({
    host: "127.0.0.1",
    port: 0,
    state,
    saveState: (value) => saves.push(structuredClone(value)),
    processTurn: async ({ text, turnId }) => {
      turns.push({ text, turnId, state: structuredClone(state) });
      if (overrides.fail) throw new Error("provider-down");
      return { answer: `Svar: ${text}`, outcome: "ANSWERED" };
    },
    transcribeAudio: async () => ({ ok: true, text: "starta bryggan" }),
    nowMs: () => 1234,
  });
  return { server, state, saves, turns };
}

feature("Windows manager phone endpoint", () => {
  component("discovery is independent from WSL", {
    given: ["a Windows-native listener", async () => {
      const context = setup();
      const address = await context.server.start();
      return { ...context, url: `http://127.0.0.1:${address.port}` };
    }],
    when: ["the phone reads its target", ({ url }) => fetch(`${url}/api/audio/config`).then((r) => r.json())],
    then: ["Windows rescue is the explicit favorite", async (body, context) => {
      expect(body).toMatchObject({
        service: "agentmux-windows-manager-audio",
        schemaVersion: 1,
        targets: [{ id: "windows", favorite: true }],
      });
      await context.server.close();
    }],
  });

  component("a text turn journals before execution and replays its answer exactly once", {
    given: ["one fresh manager state", async () => {
      const context = setup();
      const address = await context.server.start();
      return { ...context, url: `http://127.0.0.1:${address.port}` };
    }],
    when: ["the same idempotency key arrives twice", async ({ url }) => ({
      first: await post(url, { text: "status", idempotencyKey: "phone-1" }),
      replay: await post(url, { text: "status", idempotencyKey: "phone-1" }),
    })],
    then: ["one turn runs and the completed answer is replayed", async (result, context) => {
      expect(result.first).toMatchObject({ status: 200, body: { answer: "Svar: status" } });
      expect(result.replay).toMatchObject({ status: 200, body: { replayed: true } });
      expect(context.turns).toHaveLength(1);
      expect(context.turns[0].state.phoneTurns["phone-1"].status).toBe("started");
      expect(context.saves.map((row) => row.phoneTurns["phone-1"].status))
        .toEqual(["started", "completed"]);
      await context.server.close();
    }],
  });

  component("audio is transcribed once and a failed turn is never retried", {
    given: ["a manager whose provider fails after transcription", async () => {
      const context = setup({ fail: true });
      const address = await context.server.start();
      return { ...context, url: `http://127.0.0.1:${address.port}` };
    }],
    when: ["the phone repeats the failed key", async ({ url }) => {
      const body = { audio: Buffer.from("audio").toString("base64"), filename: "x.m4a", idempotencyKey: "phone-2" };
      return { first: await post(url, body), replay: await post(url, body) };
    }],
    then: ["the second request is fenced without a second manager turn", async (result, context) => {
      expect(result.first.status).toBe(500);
      expect(result.replay).toMatchObject({ status: 409, body: { error: "turn-failed" } });
      expect(context.turns).toHaveLength(1);
      expect(context.turns[0].text).toBe("starta bryggan");
      await context.server.close();
    }],
  });
});
