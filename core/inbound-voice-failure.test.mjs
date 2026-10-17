import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDiscordInboundStore } from "./discord-inbound-store.mjs";
import { createInboundReconciler } from "./inbound-reconciler.mjs";
import { createAttachmentHandler } from "../attachments.mjs";

describe("voice failure is still delivered", () => {
  it.each(["success", "failure"])("suppresses an in-flight provider %s after the recipient resolves the message", async result => {
    const root = mkdtempSync(join(tmpdir(), "voice-resolved-"));
    const store = createDiscordInboundStore({ rootDir: root, downloadBuffer: async () => Buffer.from("audio") });
    let release, started;
    const ready = new Promise(resolve => { started = resolve; });
    const provider = new Promise(resolve => { release = resolve; });
    const handler = createAttachmentHandler({ transcribeScript: "/transcribe", run: async () => {
      started(); await provider;
      if (result === "failure") throw Error("late provider failure");
      return { stdout: "Late transcript that must not be posted." };
    } });
    const delivered = [], posted = [];
    const reconciler = createInboundReconciler({ store, resolveTarget: () => ({ agentName: "claw", pane: 0 }),
      onMessage: async msg => { const prompt = await handler.buildPrompt(msg, []); if (prompt) delivered.push(prompt); return { delivered: true }; } });
    try {
      const pending = reconciler.enqueue({ id: "resolved", channelId: "channel", text: "", attachments: [
        { id: "audio", name: "voice.ogg", contentType: "audio/ogg", url: "fixture" },
      ] }, { async send(_id, payload) { posted.push(payload); } });
      await ready;
      store.complete(store.read("channel", "resolved"), { recipientHandled: true, transcriptDeliveredByAmux: false });
      release(); await pending;
      expect({ delivered, posted }).toEqual({ delivered: [], posted: [] });
      expect(store.read("channel", "resolved").outcome).toEqual({ recipientHandled: true, transcriptDeliveredByAmux: false });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  it("delivers the 15 October deadline failure once, drains later text, then delivers the retried transcript", async () => {
    const root = mkdtempSync(join(tmpdir(), "voice-deadline-"));
    let now = 1792040133471, fail = true, failSecond = false;
    const store = createDiscordInboundStore({ rootDir: root, now: () => now,
      downloadBuffer: async () => Buffer.from("durable voice bytes") });
    const target = { agentName: "claw", pane: 0, dir: "/workspace" };
    const voice = { id: "1560154140976488498", channelId: "channel", authorId: "human", text: "", createdTimestamp: now,
      attachments: [{ id: "audio", name: "voice-message.ogg", contentType: "audio/ogg", url: "fixture" },
        { id: "audio2", name: "second.ogg", contentType: "audio/ogg", url: "fixture2" }] };
    const handler = createAttachmentHandler({ transcribeScript: "/transcribe", run: async command => {
      if (fail || failSecond && command.includes("audio2.ogg")) throw Object.assign(new Error("Gemini 504 DEADLINE_EXCEEDED"), { stderr: "504 DEADLINE_EXCEEDED" });
      return { stdout: "My top two games are A and B." };
    } });
    const accepted = new Map(), notices = new Map();
    let lostNoticeAck = false;
    const channel = { async send(_id, payload) {
      notices.set(payload.nonce, payload);
      if (!lostNoticeAck) { lostNoticeAck = true; throw new Error("Discord accepted notice but acknowledgement was lost"); }
    },
      async findMessageByNonce(_id, nonce) { return notices.has(nonce); } };
    const reconciler = createInboundReconciler({ store, resolveTarget: () => target,
      onMessage: async msg => {
        const prompt = await handler.buildPrompt(msg, []);
        if (!accepted.has(msg.id)) accepted.set(msg.id, prompt);
        return { delivered: true };
      } });
    try {
      // Real record shape: privately downloaded bytes, no transcript, retryable provider error.
      const record = store.observe(voice, target);
      await store.prepareAttachments(record);
      store.observe({ ...voice, id: "later", text: "Did you read my voice message?", attachments: [] }, target);
      await reconciler.drain(channel, voice.channelId).catch(() => {});
      expect([...accepted.values()]).toEqual([expect.stringContaining("DEADLINE_EXCEEDED"), "Did you read my voice message?"]);
      expect([...accepted.values()][0]).not.toContain("AMUX will retry");
      expect([...accepted.values()][0]).toContain("Check the audio file");
      expect([...accepted.values()][0]).toContain(store.read("channel", voice.id).attachments[0].durablePath);
      expect(store.read("channel", voice.id).status).not.toBe("completed");
      now += 31_000;
      await reconciler.drain(channel, "channel").catch(() => {});
      expect(accepted.size).toBe(2);
      expect(store.read("channel", voice.id).lastError).toContain("DEADLINE_EXCEEDED");
      fail = false; failSecond = true; now += 31_000;
      await reconciler.drain(channel, "channel");
      expect(accepted.size).toBe(2);
      failSecond = false; now += 31_000;
      await reconciler.drain(channel, "channel");
      expect(accepted.size).toBe(3);
      expect(accepted.get(voice.id)).toContain("My top two games are A and B.");
      expect(store.read("channel", voice.id).status).toBe("completed");
      expect([...notices.values()].filter(payload => payload.content?.includes("Transcription unavailable"))).toHaveLength(1);
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
  // 2026-10-17: skyvw:0 got the 06:32Z voice note and its 06:39Z resend (same bytes) as two
  // late transcripts with nothing saying they were old. Mattias: "tänk igenom hur staet ska vara".
  it("delivers a failed voice note and its resend once, marked as late, after transcription recovers", async () => {
    const root = mkdtempSync(join(tmpdir(), "voice-resend-"));
    let now = Date.UTC(2026, 9, 17, 6, 32, 59), fail = true;
    const store = createDiscordInboundStore({ rootDir: root, now: () => now,
      downloadBuffer: async () => Buffer.from("the same voice note bytes") });
    const target = { agentName: "skyvw", pane: 0, dir: "/workspace" };
    const voice = (id, createdTimestamp) => ({ id, channelId: "channel", authorId: "human", text: "", createdTimestamp,
      attachments: [{ id: `${id}-audio`, name: "voice-message.ogg", contentType: "audio/ogg", url: "fixture" }] });
    const handler = createAttachmentHandler({ transcribeScript: "/transcribe", run: async () => {
      if (fail) throw Object.assign(new Error("Command failed"), { stderr: "[stt] gemini x2 + whisper1 all failed" });
      return { stdout: "Hur lägger man upp exempelfilmen?" };
    } });
    const prompts = [];
    const reconciler = createInboundReconciler({ store, resolveTarget: () => target,
      onMessage: async msg => { prompts.push(await handler.buildPrompt(msg, [])); return { delivered: true }; } });
    const channel = { async send() {}, async findMessageByNonce() { return false; } };
    try {
      for (const msg of [voice("original", now), voice("resend", now + 408_000)]) {
        await store.prepareAttachments(store.observe(msg, target));
      }
      now += 410_000;
      await reconciler.drain(channel, "channel").catch(() => {});
      fail = false; now += 31_000;
      await reconciler.drain(channel, "channel");
      const transcripts = prompts.filter(prompt => prompt?.includes("exempelfilmen"));
      expect(transcripts).toHaveLength(1);
      expect(transcripts[0]).toMatch(/^\[transcribed voice[^\]]*sent 06:32Z, delivered late after a failed transcription/);
      expect(store.read("channel", "resend")).toMatchObject({ status: "completed", outcome: { duplicateOf: "original" } });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
