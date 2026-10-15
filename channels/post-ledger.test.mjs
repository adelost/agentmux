import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { appendPost, readWindow } from "../core/ask-ledger.mjs";
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
  component("successful posts retain Discord's accepted text rather than the attempted payload", {
    given: ["Discord removed a trailing newline but kept the attachment", workspace],
    when: ["recording the actual successful response", ws => {
      recordDiscordPost({ channelId: "c-1", payload: { content: "Exakt åäö.\n", files: ["/tmp/proof.png"] },
        message: { id: "normalized-message", content: "Exakt åäö." }, kind: "reply", via: "bridge" },
      { configPath: ws.configPath, record: entry => appendPost(entry, { path: ws.path }) });
      return readWindow({ path: ws.path }).posts;
    }],
    then: ["the stored output is exactly what the recipient sees", rows => expect(rows[0]).toMatchObject({
      text: "Exakt åäö.", files: ["/tmp/proof.png"], messageId: "normalized-message",
    })], cleanup: ws => ws.cleanup(),
  });
  component("an edited delivery notice records the content that is now visible", {
    given: ["the real adapter with one existing bot message", () => {
      const ws = workspace();
      const edited = { id: "edited-message" };
      const client = { channels: { fetch: async () => ({ messages: { fetch: async () => ({ edit: async () => edited }) } }) } };
      const discord = createDiscordChannel({ token: "test", client,
        onSent: (channelId, entry) => recordDiscordPost({ ...entry, channelId, via: "bridge" },
          { configPath: ws.configPath, record: entry => appendPost(entry, { path: ws.path }) }) });
      return { ws, discord };
    }],
    when: ["the waiting notice changes to delivered", async fx => {
      await fx.discord.editMessage("c-1", "edited-message", "Mottaget, leveransen är kvitterad.");
      return readWindow({ path: fx.ws.path }).posts;
    }],
    then: ["the actual message id and exact updated text are readable", rows => expect(rows).toEqual([
      expect.objectContaining({ messageId: "edited-message", text: "Mottaget, leveransen är kvitterad.", status: "sent" }),
    ])],
    cleanup: fx => fx.ws.cleanup(),
  });
  component("the bridge adapter records send, replyTo and a reply to a person's message", {
    given: ["a bridge adapter over a fake Discord client", () => {
      const ws = workspace();
      const sent = { id: "m-1" };
      const channel = { send: async () => sent, messages: { fetch: async () => ({ reply: async () => ({ id: "m-2" }) }) } };
      const refused = { send: async () => { throw Object.assign(new Error("Missing Permissions"), { code: 50013 }); } };
      const client = { channels: { fetch: async (id) => (id === "c-refused" ? refused : channel) } };
      const onSent = (channelId, post) => recordDiscordPost({ ...post, channelId, via: "bridge" },
        { configPath: ws.configPath, record: (entry) => appendPost(entry, { path: ws.path }) });
      const discord = createDiscordChannel({ token: "test", onSent, client });
      const person = normalizeDiscordMessage({ channelId: "c-0", content: "hej", author: { id: "u", bot: false },
        attachments: new Map(), reply: async () => ({ id: "m-3" }), channel: { send: async () => ({ id: "m-4" }) } }, { onSent });
      return { ws, discord, person };
    }],
    when: ["an agent reply, a delivery notice and a command answer are posted", async ({ ws, discord, person }) => {
      await discord.send("c-1", { content: REPLY, files: ["/tmp/shot.png"] }, { kind: "reply" });
      await discord.replyTo("c-0", "origin", "levererat till lsrc:0");
      await person.reply("kvot: 40 %");
      const refused = await discord.send("c-refused", "SUMMARY: nådde aldrig fram", { kind: "reply" }).catch((error) => error.message);
      return { rows: readWindow({ path: ws.path }).posts, refused };
    }],
    then: ["four rows, each with its pane, kind, whole text and outcome; the refused send still throws", ({ rows, refused }, { ws }) => {
      try {
        expect(refused).toBe("Missing Permissions");
        // Rows in the same millisecond order by id, so compare without order.
        expect(rows).toHaveLength(4);
        expect(rows.map(({ agent, pane, kind, via, text, files, messageId, status, error }) =>
          ({ agent, pane, kind, via, text, files, messageId, status, error }))).toEqual(expect.arrayContaining([
          { agent: "lsrc", pane: 1, kind: "reply", via: "bridge", text: REPLY, files: ["/tmp/shot.png"], messageId: "m-1", status: "sent", error: undefined },
          { agent: "lsrc", pane: 0, kind: "notice", via: "bridge", text: "levererat till lsrc:0", files: [], messageId: "m-2", status: "sent", error: undefined },
          { agent: "lsrc", pane: 0, kind: "notice", via: "bridge", text: "kvot: 40 %", files: [], messageId: "m-3", status: "sent", error: undefined },
          { agent: null, pane: null, kind: "reply", via: "bridge", text: "SUMMARY: nådde aldrig fram", files: [], messageId: null, status: "failed", error: "50013: Missing Permissions" },
        ]));
      } finally { ws.cleanup(); }
    }],
  });

  component("the CLI records a mirrored send, an image and a voice file", {
    given: ["the CLI with a stubbed Discord REST endpoint", () => {
      const ws = workspace();
      const audio = join(ws.root, "svar.mp3");
      writeFileSync(audio, "mp3");
      let next = 0;
      const fetch = vi.fn(async (url, init) => (String(init?.body || "").includes("avvisad")
        ? { ok: false, status: 403, text: async () => "Missing Access" }
        : { ok: true, json: async () => ({ id: `r-${++next}` }) }));
      const restore = { token: process.env.DISCORD_TOKEN, config: process.env.AGENTS_YAML, ledger: process.env.AMUX_ASK_LEDGER_PATH };
      vi.stubGlobal("fetch", fetch);
      Object.assign(process.env, { DISCORD_TOKEN: "test", AGENTS_YAML: ws.configPath, AMUX_ASK_LEDGER_PATH: ws.path });
      return { ws, audio, restore };
    }],
    when: ["mirroring a brief, posting an image and a spoken answer", async ({ ws, audio }) => {
      await sendToChannelId("c-1", REPLY, { kind: "mirror" });
      await sendFileToChannelId("c-0", audio, "skärmbild");
      await sendFileToChannelId("c-0", audio, "uppläst svar", { kind: "voice" });
      const rejected = await sendToChannelId("c-1", "avvisad brief", { kind: "mirror" }).catch((error) => error.message);
      return { rows: readWindow({ path: ws.path }).posts, rejected };
    }],
    then: ["four rows with the whole text, file paths and outcome; the rejected post still throws", ({ rows, rejected }, { ws, audio, restore }) => {
      try {
        expect(rejected).toBe("discord post 403: Missing Access");
        expect(rows).toHaveLength(4);
        expect(rows.map(({ agent, pane, kind, via, text, files, status }) => ({ agent, pane, kind, via, text, files, status }))).toEqual(expect.arrayContaining([
          { agent: "lsrc", pane: 1, kind: "mirror", via: "cli", text: REPLY, files: [], status: "sent" },
          { agent: "lsrc", pane: 0, kind: "file", via: "cli", text: "skärmbild", files: [audio], status: "sent" },
          { agent: "lsrc", pane: 0, kind: "voice", via: "cli", text: "uppläst svar", files: [audio], status: "sent" },
          { agent: "lsrc", pane: 1, kind: "mirror", via: "cli", text: "avvisad brief", files: [], status: "failed" },
        ]));
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
