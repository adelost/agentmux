import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, feature, unit } from "bdd-vitest";
import { createMockProvider } from "../core/windows-manager.mjs";
import { pollManagerChannel, readManagerConfig, reconcileManagerStartup } from "./windows-manager.mjs";

const CONFIG = { channelId: "123456789012345678", authorizedUserId: "111111111111111111" };
const NOW = 1_000_000;

function makeHarness({ messages, scripted }) {
  const temporary = mkdtempSync(join(tmpdir(), "amux-manager-smoke-"));
  const statePath = join(temporary, "manager-state.json");
  const writes = [];
  const sent = [];
  const executed = [];
  let chats = 0;
  const base = createMockProvider(scripted);
  const deps = {
    generation: "g1",
    nowMs: () => NOW,
    saveState: (next) => {
      writes.push(structuredClone(next));
      writeFileSync(statePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
    },
    observe: async () => ({ wsl: "offline", wslReachable: false }),
    executeTool: async (name) => {
      const onDisk = JSON.parse(readFileSync(statePath, "utf8"));
      expect(onDisk.lastAction.status).toBe("started");
      expect(onDisk.lastAction.command).toBe(name);
      executed.push(name);
      return {
        ok: true,
        stage: name,
        detail: "AMUX READY reason=ok",
        ...(name === "get_status" ? { observation: { wsl: "offline", wslReachable: false } } : {}),
      };
    },
    listMessages: async () => messages,
    sendMessage: async (text) => {
      sent.push(text);
    },
    provider: { name: "mock", chat: async (input) => { chats += 1; return base.chat(input); } },
    transcribeMessage: async () => ({ ok: false, reason: "unexpected-voice" }),
  };
  return {
    deps,
    sent,
    executed,
    writes,
    chats: () => chats,
    cleanup: () => rmSync(temporary, { recursive: true, force: true }),
  };
}

feature("windows manager smoke", () => {
  unit("required config reports missing, invalid and valid files distinctly", {
    then: ["operator output never calls malformed JSON missing", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-manager-config-"));
      const path = join(root, "manager.json");
      try {
        expect(() => readManagerConfig(path)).toThrow(/config missing/u);
        writeFileSync(path, "{broken", "utf8");
        expect(() => readManagerConfig(path)).toThrow(/config invalid JSON/u);
        writeFileSync(path, `\uFEFF${JSON.stringify(CONFIG)}`, "utf8");
        expect(readManagerConfig(path)).toEqual(CONFIG);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }],
  });

  unit("status is local, journals before the tool, and advances the cursor once", {
    then: ["rescue text never needs a provider turn", async () => {
      const harness = makeHarness({
        messages: [{ id: "100", content: "hur mår läget?", author: { id: CONFIG.authorizedUserId, bot: false } }],
        scripted: [],
      });
      try {
        const state = { schemaVersion: 1, lastSeenId: null, lastAction: null, lastStatusMs: null };
        const handled = await pollManagerChannel({ config: CONFIG, state, history: [], deps: harness.deps });
        expect(handled).toBe(1);
        expect(harness.executed).toEqual(["get_status"]);
        expect(harness.chats()).toBe(0);
        expect(harness.sent).toEqual(["AMUX READY reason=ok"]);
        expect(state.lastSeenId).toBe("100");
        expect(state.lastAction.status).toBe("completed");
        expect(state.lastAction.stage).toBe("RECOVERED");
        expect(harness.writes.filter((write) => write.lastSeenId === "100")).toHaveLength(1);
        expect(harness.writes.map((write) => write.lastAction?.command)).toEqual([
          "manager-turn",
          "get_status",
          "get_status",
          "get_status",
        ]);
      } finally {
        harness.cleanup();
      }
    }],
  });

  unit("a WSL crash runs the bounded local recovery even when the provider has no replies", {
    then: ["status precedes recover and no model call is made", async () => {
      const harness = makeHarness({
        messages: [{ id: "105", content: "WSL har kraschat", author: { id: CONFIG.authorizedUserId, bot: false } }],
        scripted: [],
      });
      try {
        const state = { schemaVersion: 1, lastSeenId: null, lastAction: null, lastStatusMs: null };
        expect(await pollManagerChannel({ config: CONFIG, state, history: [], deps: harness.deps })).toBe(1);
        expect(harness.executed).toEqual(["get_status", "recover"]);
        expect(harness.chats()).toBe(0);
        expect(harness.sent[0]).toContain("AMUX RECOVERED lokal recovery");
        expect(state.lastSeenId).toBe("105");
      } finally {
        harness.cleanup();
      }
    }],
  });

  unit("general chat degrades to actionable rescue help when the provider fails", {
    then: ["a provider error never claims the Windows rescue channel itself is blocked", async () => {
      const harness = makeHarness({
        messages: [{ id: "106", content: "hej", author: { id: CONFIG.authorizedUserId, bot: false } }],
        scripted: [{ ok: false, reason: "exit-127" }],
      });
      try {
        const state = { schemaVersion: 1, lastSeenId: null, lastAction: null, lastStatusMs: null };
        expect(await pollManagerChannel({ config: CONFIG, state, history: [], deps: harness.deps })).toBe(1);
        expect(harness.chats()).toBe(1);
        expect(harness.executed).toEqual([]);
        expect(harness.sent[0]).toContain("AMUX PARTIAL manager-ai=exit-127");
        expect(harness.sent[0]).toContain("Rescue fungerar utan AI");
        expect(state.lastAction.stage).toBe("PARTIAL");
      } finally {
        harness.cleanup();
      }
    }],
  });

  unit("a leftover started action is fenced and never re-executed", {
    then: ["startup marks blocked crashed-mid-action and the cursor skips the message", async () => {
      const state = {
        schemaVersion: 1,
        lastSeenId: null,
        lastStatusMs: null,
        lastAction: {
          schemaVersion: 1,
          messageId: "100",
          command: "get_status",
          generation: "g0",
          status: "started",
          startedAt: new Date(0).toISOString(),
        },
      };
      const startup = reconcileManagerStartup(state, { nowMs: NOW });
      expect(startup.fenced).toBe(true);
      expect(startup.fencedMessageId).toBe("100");
      expect(state.lastAction.status).toBe("blocked");
      expect(state.lastAction.stage).toBe("crashed-mid-action");
      expect(state.lastSeenId).toBe("100");
      let executed = 0;
      let chatted = 0;
      const handled = await pollManagerChannel({
        config: CONFIG,
        state,
        history: [],
        deps: {
          generation: "g1",
          nowMs: () => NOW,
          saveState: () => {},
          observe: async () => ({ wsl: "unknown" }),
          executeTool: async () => { executed += 1; return { ok: true, stage: "x", detail: "x" }; },
          listMessages: async (after) => {
            expect(after).toBe("100");
            return [];
          },
          sendMessage: async () => {},
          provider: { name: "mock", chat: async () => { chatted += 1; return { ok: true, text: "x" }; } },
        },
      });
      expect(handled).toBe(0);
      expect(executed).toBe(0);
      expect(chatted).toBe(0);
      expect(state.lastAction.status).toBe("blocked");
    }],
  });

  unit("bots, strangers, and restarter commands never reach the provider", {
    then: ["all skipped with the cursor advanced and zero journal entries", async () => {
      const harness = makeHarness({
        messages: [
          { id: "101", content: "hej", author: { id: CONFIG.authorizedUserId, bot: true } },
          { id: "102", content: "hej", author: { id: "999999999999999999", bot: false } },
          { id: "103", content: "//status", author: { id: CONFIG.authorizedUserId, bot: false } },
        ],
        scripted: [],
      });
      try {
        const state = { schemaVersion: 1, lastSeenId: null, lastAction: null, lastStatusMs: null };
        const handled = await pollManagerChannel({ config: CONFIG, state, history: [], deps: harness.deps });
        expect(handled).toBe(0);
        expect(harness.chats()).toBe(0);
        expect(harness.executed).toEqual([]);
        expect(harness.sent).toEqual([]);
        expect(state.lastSeenId).toBe("103");
        expect(state.lastAction).toBeNull();
        expect(harness.writes).toHaveLength(3);
      } finally {
        harness.cleanup();
      }
    }],
  });

  unit("one Discord voice note is transcribed, echoed visibly, and answered once", {
    then: ["the exact transcript enters the normal manager turn after a durable journal write", async () => {
      const harness = makeHarness({
        messages: [{
          id: "104",
          content: "",
          flags: 8192,
          attachments: [{
            url: "https://cdn.discordapp.com/attachments/1/2/voice-message.ogg",
            size: 3,
            content_type: "audio/ogg",
          }],
          author: { id: CONFIG.authorizedUserId, bot: false },
        }],
        scripted: ["Jag hörde dig."],
      });
      harness.deps.transcribeMessage = async () => ({ ok: true, text: "Kan du kontrollera WSL?" });
      try {
        const state = { schemaVersion: 1, lastSeenId: null, lastAction: null, lastStatusMs: null };
        expect(await pollManagerChannel({ config: CONFIG, state, history: [], deps: harness.deps })).toBe(1);
        expect(harness.sent).toEqual(["🎙️ Kan du kontrollera WSL?", "Jag hörde dig."]);
        expect(harness.chats()).toBe(1);
        expect(harness.writes[0].lastAction.command).toBe("manager-voice-turn");
        expect(state.lastSeenId).toBe("104");
      } finally {
        harness.cleanup();
      }
    }],
  });
});
