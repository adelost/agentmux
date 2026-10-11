import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { appendPostLedger, readPostLedger } from "../core/ask-ledger.mjs";
import { createDiscordChannel } from "./discord.mjs";
import { normalizeDiscordMessage } from "./normalize.mjs";
import { recordDiscordPost } from "./post-ledger.mjs";
import { sendFileToChannelId, sendToChannelId } from "../cli/send-notify.mjs";

const REPLY = `SUMMARY: klart. ${"bevis ".repeat(320)}`.slice(0, 1990);

function workspace() {
  const root = mkdtempSync(join(tmpdir(), "amux-post-ledger-"));
  const configPath = join(root, "agents.yaml");
  writeFileSync(configPath, "lsrc:\n  dir: /work\n  panes: [{cmd: claude}, {cmd: codex}]\n  discord:\n    \"c-0\": 0\n    \"c-1\": 1\n");
  return { root, configPath, path: join(root, "ask-ledger.jsonl"), cleanup: () => rmSync(root, { recursive: true, force: true }) };
}

feature("every Discord send point records what it posted", () => {
  component("the bridge adapter records send, replyTo and a reply to a person's message", {
    given: ["a bridge adapter over a fake Discord client", () => {
      const ws = workspace();
      const sent = { id: "m-1" };
      const channel = { send: async () => sent, messages: { fetch: async () => ({ reply: async () => ({ id: "m-2" }) }) } };
      const client = { channels: { fetch: async () => channel } };
      const onSent = (channelId, post) => recordDiscordPost({ ...post, channelId, via: "bridge" },
        { configPath: ws.configPath, record: (entry) => appendPostLedger(entry, { path: ws.path }) });
      const discord = createDiscordChannel({ token: "test", onSent, client });
      const person = normalizeDiscordMessage({ channelId: "c-0", content: "hej", author: { id: "u", bot: false },
        attachments: new Map(), reply: async () => ({ id: "m-3" }), channel: { send: async () => ({ id: "m-4" }) } }, { onSent });
      return { ws, discord, person };
    }],
    when: ["an agent reply, a delivery notice and a command answer are posted", async ({ ws, discord, person }) => {
      await discord.send("c-1", { content: REPLY, files: ["/tmp/shot.png"] }, { kind: "reply" });
      await discord.replyTo("c-0", "origin", "levererat till lsrc:0");
      await person.reply("kvot: 40 %");
      return readPostLedger({ path: ws.path });
    }],
    then: ["three rows, each with its pane, kind and whole text", (rows, { ws }) => {
      try {
        expect(rows.map(({ agent, pane, kind, via, text, files, messageId }) => ({ agent, pane, kind, via, text, files, messageId })))
          .toEqual([
            { agent: "lsrc", pane: 1, kind: "reply", via: "bridge", text: REPLY, files: ["/tmp/shot.png"], messageId: "m-1" },
            { agent: "lsrc", pane: 0, kind: "notice", via: "bridge", text: "levererat till lsrc:0", files: [], messageId: "m-2" },
            { agent: "lsrc", pane: 0, kind: "notice", via: "bridge", text: "kvot: 40 %", files: [], messageId: "m-3" },
          ]);
      } finally { ws.cleanup(); }
    }],
  });

  component("the CLI records a mirrored send, an image and a voice file", {
    given: ["the CLI with a stubbed Discord REST endpoint", () => {
      const ws = workspace();
      const audio = join(ws.root, "svar.mp3");
      writeFileSync(audio, "mp3");
      let next = 0;
      const fetch = vi.fn(async () => ({ ok: true, json: async () => ({ id: `r-${++next}` }) }));
      const restore = { token: process.env.DISCORD_TOKEN, config: process.env.AGENTS_YAML, ledger: process.env.AMUX_ASK_LEDGER_PATH };
      vi.stubGlobal("fetch", fetch);
      Object.assign(process.env, { DISCORD_TOKEN: "test", AGENTS_YAML: ws.configPath, AMUX_ASK_LEDGER_PATH: ws.path });
      return { ws, audio, restore };
    }],
    when: ["mirroring a brief, posting an image and a spoken answer", async ({ ws, audio }) => {
      await sendToChannelId("c-1", REPLY, { kind: "mirror" });
      await sendFileToChannelId("c-0", audio, "skärmbild");
      await sendFileToChannelId("c-0", audio, "uppläst svar", { kind: "voice" });
      return readPostLedger({ path: ws.path });
    }],
    then: ["three rows with the whole text and the file paths", (rows, { ws, audio, restore }) => {
      try {
        expect(rows.map(({ agent, pane, kind, via, text, files }) => ({ agent, pane, kind, via, text, files }))).toEqual([
          { agent: "lsrc", pane: 1, kind: "mirror", via: "cli", text: REPLY, files: [] },
          { agent: "lsrc", pane: 0, kind: "file", via: "cli", text: "skärmbild", files: [audio] },
          { agent: "lsrc", pane: 0, kind: "voice", via: "cli", text: "uppläst svar", files: [audio] },
        ]);
      } finally {
        vi.unstubAllGlobals();
        for (const [key, name] of [["token", "DISCORD_TOKEN"], ["config", "AGENTS_YAML"], ["ledger", "AMUX_ASK_LEDGER_PATH"]]) {
          if (restore[key] === undefined) delete process.env[name]; else process.env[name] = restore[key];
        }
        ws.cleanup();
      }
    }],
  });
});
