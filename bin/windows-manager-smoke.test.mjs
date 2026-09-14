import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, feature, unit } from "bdd-vitest";
import { createMockProvider } from "../core/windows-manager.mjs";
import { reconcileManagerStartup } from "../core/windows-manager-discord.mjs";
import { createRunningBootReader, watchWslBoot } from "../core/windows-manager-boot.mjs";
import { pollManagerChannel, readManagerConfig, runManagerTurn } from "./windows-manager.mjs";

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
        // The message is consumed in the same write that accepts it, before any tool runs.
        expect(harness.writes[0].lastSeenId).toBe("100");
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

  unit("an explicit WSL restart request runs the local restart even when the provider has no replies", {
    then: ["status precedes one restart and no model call is made", async () => {
      const harness = makeHarness({
        messages: [{ id: "105", content: "Ok, WSL har kraschat och behöver startas om", author: { id: CONFIG.authorizedUserId, bot: false } }],
        scripted: [],
      });
      try {
        const state = { schemaVersion: 1, lastSeenId: null, lastAction: null, lastStatusMs: null };
        expect(await pollManagerChannel({ config: CONFIG, state, history: [], deps: harness.deps })).toBe(1);
        expect(harness.executed).toEqual(["get_status", "restart_wsl", "get_status"]);
        expect(harness.chats()).toBe(0);
        expect(harness.sent[0]).toContain("AMUX startar om WSL nu");
        expect(harness.sent.at(-1)).toContain("AMUX RECOVERED lokal recovery");
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

  unit("a session id from the tool followup overwrites the persisted one", {
    then: ["the newer exact id wins across the whole turn", async () => {
      const harness = makeHarness({
        messages: [{ id: "110", content: "hej", author: { id: CONFIG.authorizedUserId, bot: false } }],
        scripted: [
          { ok: true, text: '{"tool":"get_status"}', sessionId: "old-session" },
          { ok: true, text: "Läget är stabilt.", sessionId: "new-session" },
        ],
      });
      try {
        const state = { schemaVersion: 1, lastSeenId: null, lastAction: null, lastStatusMs: null, codexSessionId: "seed-session" };
        expect(await pollManagerChannel({ config: CONFIG, state, history: [], deps: harness.deps })).toBe(1);
        expect(harness.chats()).toBe(2);
        expect(harness.executed).toEqual(["get_status"]);
        expect(state.codexSessionId).toBe("new-session");
        expect(harness.writes.at(-1).codexSessionId).toBe("new-session");
      } finally {
        harness.cleanup();
      }
    }],
  });

  unit("restart targets never borrow destructive meaning from manager prose", {
    then: ["a direct imperative restarts WSL while explicit models stay with the provider", async () => {
      const harness = makeHarness({
        messages: [],
        scripted: [{ ok: true, text: "Allt lugnt, ingen rescue här." }],
      });
      harness.deps.executeTool = async (name) => {
        harness.executed.push(name);
        return {
          ok: true,
          stage: name,
          detail: name === "get_status" ? "windows=online wsl=unknown boot=unknown" : "AMUX RECOVERED lokal recovery",
          ...(name === "get_status" ? { observation: { wsl: "unknown", wslReachable: false } } : {}),
        };
      };
      try {
        const state = { schemaVersion: 1, lastSeenId: null, lastAction: null, lastStatusMs: null };
        harness.deps.listMessages = async () => [
          { id: "201", content: "status", author: { id: CONFIG.authorizedUserId, bot: false } },
        ];
        expect(await pollManagerChannel({ config: CONFIG, state, history: [], deps: harness.deps })).toBe(1);
        harness.deps.listMessages = async () => [
          { id: "202", content: "Men förhelvet.. starata om du omedelbums..", author: { id: CONFIG.authorizedUserId, bot: false } },
        ];
        expect(await pollManagerChannel({ config: CONFIG, state, history: [], deps: harness.deps })).toBe(1);
        expect(harness.executed).toEqual(["get_status", "get_status", "restart_wsl", "get_status"]);
        // The previous local answer names WSL, but the explicit model target
        // must not inherit it or execute any further tool.
        harness.deps.listMessages = async () => [
          { id: "203", content: "starta om modellerna då", author: { id: CONFIG.authorizedUserId, bot: false } },
        ];
        expect(await pollManagerChannel({ config: CONFIG, state, history: [], deps: harness.deps })).toBe(1);
        expect(harness.executed).toEqual(["get_status", "get_status", "restart_wsl", "get_status"]);
        expect(harness.chats()).toBe(1);
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

  unit("bots and strangers never reach the provider", {
    then: ["both skipped silently with the cursor advanced and zero journal entries", async () => {
      const harness = makeHarness({
        messages: [
          { id: "101", content: "hej", author: { id: CONFIG.authorizedUserId, bot: true } },
          { id: "102", content: "//restart-wsl", author: { id: "999999999999999999", bot: false } },
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
        expect(state.lastSeenId).toBe("102");
        expect(state.lastAction).toBeNull();
      } finally {
        harness.cleanup();
      }
    }],
  });

  // The manager is the only live listener on the rescue channel; the PowerShell
  // restarter that once owned //commands last polled 2026-08-01. Skipping them
  // silently dropped three //restart-wsl orders (2026-09-12..14) with no reply.
  unit("the authorized human's //commands run locally and always get an answer", {
    then: ["//status runs the probe and an unknown //command explains the vocabulary", async () => {
      const harness = makeHarness({
        messages: [
          { id: "103", content: "//status", author: { id: CONFIG.authorizedUserId, bot: false } },
          { id: "104", content: "//reboot", author: { id: CONFIG.authorizedUserId, bot: false } },
        ],
        scripted: [],
      });
      try {
        const state = { schemaVersion: 1, lastSeenId: null, lastAction: null, lastStatusMs: null };
        expect(await pollManagerChannel({ config: CONFIG, state, history: [], deps: harness.deps })).toBe(2);
        expect(harness.chats()).toBe(0);
        expect(harness.executed).toEqual(["get_status"]);
        expect(harness.sent[0]).toBe("AMUX READY reason=ok");
        expect(harness.sent[1]).toContain("AMUX BLOCKED okänt kommando //reboot");
        expect(harness.sent[1]).toContain("//restart-wsl");
        expect(state.lastSeenId).toBe("104");
      } finally {
        harness.cleanup();
      }
    }],
  });

  unit("an authorized message the manager cannot read is answered, not dropped", {
    then: ["an image-only message names why nothing ran", async () => {
      const harness = makeHarness({
        messages: [{ id: "106", content: "", attachments: [{ url: "https://cdn.discordapp.com/a.png" }], author: { id: CONFIG.authorizedUserId, bot: false } }],
        scripted: [],
      });
      try {
        const state = { schemaVersion: 1, lastSeenId: null, lastAction: null, lastStatusMs: null };
        expect(await pollManagerChannel({ config: CONFIG, state, history: [], deps: harness.deps })).toBe(0);
        expect(harness.sent).toEqual(["AMUX BLOCKED kan inte läsa meddelandet (empty-or-unsupported). Skriv text eller skicka ett röstmeddelande."]);
        expect(state.lastSeenId).toBe("106");
      } finally {
        harness.cleanup();
      }
    }],
  });

  unit("//restart-wsl announces the restart before it runs and reports whether WSL really rebooted", {
    then: ["notice with the old boot, one restart, a fresh status, and the boot change in the answer", async () => {
      const harness = makeHarness({
        messages: [{ id: "107", content: "//restart-wsl", author: { id: CONFIG.authorizedUserId, bot: false } }],
        scripted: [],
      });
      const boots = ["aaaaaaaa-1111", "bbbbbbbb-2222"];
      const sentBeforeRestart = [];
      const logged = [];
      harness.deps.log = (line) => logged.push(line);
      harness.deps.executeTool = async (name) => {
        harness.executed.push(name);
        if (name === "restart_wsl") {
          sentBeforeRestart.push(...harness.sent);
          return { ok: true, stage: "wsl-recovered", detail: "revive ok" };
        }
        const bootId = boots.shift();
        return { ok: true, stage: name, detail: `AMUX READY boot=${bootId}`, observation: { wsl: "online", wslReachable: true, bootId } };
      };
      try {
        const state = { schemaVersion: 1, lastSeenId: null, lastAction: null, lastStatusMs: null };
        expect(await pollManagerChannel({ config: CONFIG, state, history: [], deps: harness.deps })).toBe(1);
        expect(harness.executed).toEqual(["get_status", "restart_wsl", "get_status"]);
        expect(harness.chats()).toBe(0);
        expect(sentBeforeRestart).toHaveLength(1);
        expect(sentBeforeRestart[0]).toContain("AMUX startar om WSL nu");
        expect(sentBeforeRestart[0]).toContain("aaaaaaaa-1111");
        expect(harness.sent.at(-1)).toContain("WSL är omstartat: boot aaaaaaaa-1111 -> bbbbbbbb-2222");
        expect(harness.sent.at(-1)).toContain("AMUX RECOVERED");
        // Every tool outcome lands in manager.log so //logs shows what the restart did.
        expect(logged.some((line) => line.startsWith("tool restart_wsl ok=true stage=wsl-recovered detail=revive ok"))).toBe(true);
      } finally {
        harness.cleanup();
      }
    }],
  });

  unit("a restart that leaves the same boot says plainly that WSL did not restart", {
    then: ["the unchanged boot id is reported instead of a vague stage", async () => {
      const harness = makeHarness({
        messages: [{ id: "108", content: "starta om wsl", author: { id: CONFIG.authorizedUserId, bot: false } }],
        scripted: [],
      });
      harness.deps.executeTool = async (name) => {
        harness.executed.push(name);
        if (name === "restart_wsl") return { ok: false, stage: "wsl-stop", detail: "timeout" };
        return { ok: true, stage: name, detail: "AMUX READY", observation: { wsl: "online", wslReachable: true, bootId: "aaaaaaaa-1111" } };
      };
      try {
        const state = { schemaVersion: 1, lastSeenId: null, lastAction: null, lastStatusMs: null };
        await pollManagerChannel({ config: CONFIG, state, history: [], deps: harness.deps });
        expect(harness.sent.at(-1)).toContain("WSL startades INTE om: samma boot aaaaaaaa-1111");
        expect(harness.sent.at(-1)).toContain("AMUX PARTIAL");
      } finally {
        harness.cleanup();
      }
    }],
  });

  unit("a restart order runs once even when its answer cannot be sent", {
    then: ["the next poll delivers the kept answer and never restarts WSL again", async () => {
      const order = { id: "120", content: "//restart-wsl", author: { id: CONFIG.authorizedUserId, bot: false } };
      const harness = makeHarness({ messages: [], scripted: [] });
      const logged = [];
      harness.deps.log = (line) => logged.push(line);
      harness.deps.listMessages = async (after) => (after && BigInt(after) >= BigInt(order.id) ? [] : [order]);
      let discordDown = true;
      harness.deps.sendMessage = async (text) => {
        if (discordDown && text.includes("AMUX RECOVERED")) throw new Error("discord-503");
        harness.sent.push(text);
      };
      try {
        const state = { schemaVersion: 1, lastSeenId: null, lastAction: null, lastStatusMs: null };
        await pollManagerChannel({ config: CONFIG, state, history: [], deps: harness.deps }).catch(() => {});
        discordDown = false;
        await pollManagerChannel({ config: CONFIG, state, history: [], deps: harness.deps }).catch(() => {});
        expect(harness.executed.filter((name) => name === "restart_wsl")).toHaveLength(1);
        expect(harness.sent.filter((text) => text.includes("AMUX startar om WSL nu"))).toHaveLength(1);
        expect(harness.sent.filter((text) => text.includes("AMUX RECOVERED"))).toHaveLength(1);
        expect(logged.some((line) => line.includes("discord-503"))).toBe(true);
      } finally {
        harness.cleanup();
      }
    }],
  });

  unit("the same order reaching a turn twice never runs its restart twice", {
    then: ["a redelivered Link or phone message is refused before the tool runs", async () => {
      const harness = makeHarness({ messages: [], scripted: [] });
      try {
        const state = { schemaVersion: 1, lastSeenId: null, lastAction: null, lastStatusMs: null };
        const turn = { userText: "//restart-wsl", messageId: "link:abc", state, history: [], deps: harness.deps };
        await runManagerTurn(turn);
        const again = await runManagerTurn(turn);
        expect(harness.executed.filter((name) => name === "restart_wsl")).toHaveLength(1);
        expect(again.toolResults.some((result) => result.detail === "refused:already-executed")).toBe(true);
      } finally {
        harness.cleanup();
      }
    }],
  });

  unit("a WSL reboot the manager did not order is announced once, also after a manager restart", {
    then: ["one notice per boot change, silent while WSL is down, and an ordered restart is not called unordered", async () => {
      const sent = [];
      const saved = [];
      let boot = { ok: true, running: true, bootId: "bbbbbbbb-2222" };
      const deps = {
        nowMs: () => NOW,
        saveState: (next) => saved.push(structuredClone(next)),
        sendMessage: async (text) => { sent.push(text); },
        readRunningBootId: async () => boot,
      };
      // State as the manager reads it back from disk after its own restart.
      const state = JSON.parse(JSON.stringify({ schemaVersion: 1, lastBootId: "aaaaaaaa-1111", prevBootId: null }));
      await watchWslBoot({ state, deps });
      await watchWslBoot({ state, deps });
      boot = { ok: true, running: false };
      await watchWslBoot({ state, deps });
      expect(sent).toEqual(["WSL har startat om (inte via //restart-wsl): boot aaaaaaaa-1111 -> bbbbbbbb-2222."]);
      expect(state.lastBootId).toBe("bbbbbbbb-2222");
      expect(saved.at(-1).lastBootId).toBe("bbbbbbbb-2222");

      // The manager's own restart whose final status missed the new boot is reported as back up, not as unordered.
      const harness = makeHarness({ messages: [{ id: "121", content: "//restart-wsl", author: { id: CONFIG.authorizedUserId, bot: false } }], scripted: [] });
      harness.deps.executeTool = async (name) => {
        harness.executed.push(name);
        if (name === "restart_wsl") return { ok: false, stage: "restart-wsl", detail: "timeout" };
        return { ok: true, stage: name, detail: "AMUX READY", observation: { wsl: "unresponsive", wslReachable: false, bootId: name === "get_status" && harness.executed.length === 1 ? "bbbbbbbb-2222" : null } };
      };
      harness.deps.readRunningBootId = async () => ({ ok: true, running: true, bootId: "cccccccc-3333" });
      try {
        await pollManagerChannel({ config: CONFIG, state, history: [], deps: harness.deps });
        harness.sent.length = 0;
        await watchWslBoot({ state, deps: harness.deps });
        expect(harness.sent).toEqual(["WSL är uppe igen efter //restart-wsl: boot bbbbbbbb-2222 -> cccccccc-3333."]);
      } finally {
        harness.cleanup();
      }
    }],
  });

  unit("the boot watch reads the boot id only from a WSL that is already running", {
    then: ["a stopped distro is never entered, a running one is read through wsl.exe's UTF-16 list", async () => {
      const calls = [];
      let listed = "";
      const run = async (file, args) => {
        calls.push(args.join(" "));
        return args[0] === "--list"
          ? { ok: true, stdout: listed }
          : { ok: true, stdout: "d4528e2a-fb97-4544-b3c7-0a24eb4af1c2" };
      };
      const read = createRunningBootReader({ rootDir: "C:\\AgentmuxRestarter", run, readJson: () => ({ distro: "Ubuntu-22.04", linuxUser: "adelost" }), systemRoot: "C:\\Windows" });
      expect(await read()).toEqual({ ok: true, running: false });
      expect(calls).toEqual(["--list --running --quiet"]);
      // execFile decodes wsl.exe's UTF-16LE output as UTF-8, leaving a NUL after every letter.
      listed = Buffer.from("Ubuntu-22.04\r\n", "utf16le").toString("utf8");
      expect(await read()).toEqual({ ok: true, running: true, bootId: "d4528e2a-fb97-4544-b3c7-0a24eb4af1c2" });
      expect(calls.at(-1)).toBe("-d Ubuntu-22.04 -u adelost -- cat /proc/sys/kernel/random/boot_id");
    }],
  });

  unit("a status turn that is first to see an unordered reboot says so before its answer", {
    then: ["the human learns WSL restarted even when no watch tick ran yet", async () => {
      const harness = makeHarness({ messages: [{ id: "122", content: "//status", author: { id: CONFIG.authorizedUserId, bot: false } }], scripted: [] });
      harness.deps.observe = async () => ({ wsl: "online", wslReachable: true, bootId: "bbbbbbbb-2222" });
      try {
        const state = { schemaVersion: 1, lastSeenId: null, lastAction: null, lastStatusMs: null, lastBootId: "aaaaaaaa-1111" };
        await pollManagerChannel({ config: CONFIG, state, history: [], deps: harness.deps });
        expect(harness.sent[0]).toBe("WSL har startat om (inte via //restart-wsl): boot aaaaaaaa-1111 -> bbbbbbbb-2222.");
        expect(harness.sent).toHaveLength(2);
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
