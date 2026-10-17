import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAttachmentHandler } from "../attachments.mjs";
import { createDiscordInboundStore } from "./discord-inbound-store.mjs";
import { legacyTranscriptNonce } from "./discord-transcript-effect.mjs";
import { createInboundReconciler } from "./inbound-reconciler.mjs";

const cleanups = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()();
});

function fixture(status) {
  const root = mkdtempSync(join(tmpdir(), "amux-transcript-compat-"));
  cleanups.push(() => rmSync(root, { recursive: true, force: true }));
  const store = createDiscordInboundStore({ rootDir: root,
    downloadBuffer: async () => Buffer.from("voice") });
  const message = { id: "210", channelId: "200", text: "", authorId: "human",
    isBot: false, createdTimestamp: 1_000,
    attachments: [{ id: "610", name: "voice.ogg", url: "voice",
      contentType: "audio/ogg" }] };
  const record = store.observe(message, { agentName: "lsrc", pane: 5, dir: null });
  return store.prepareAttachments(record).then((ready) => {
    store.saveTranscript(ready, "610", "journaled transcript");
    store.update(ready, { effects: { "transcript-reply": { status, attempts: 1 } } });
    return { store, message };
  });
}

describe("Discord transcript journal compatibility", () => {
  it.each(["sending", "sent"])("resumes a legacy %s first reply without reposting", async (status) => {
    const { store } = await fixture(status);
    const replyTo = vi.fn(async () => { throw new Error("duplicate transcript reply"); });
    const findMessageByNonce = vi.fn(async (_channelId, nonce) =>
      nonce === legacyTranscriptNonce("discord:200:210", 0));
    const channel = { send: vi.fn(), replyTo, findMessageByNonce, sendTyping: vi.fn() };
    const run = vi.fn(async () => ({ stdout: "rerun must not happen", stderr: "" }));
    const attachmentHandler = createAttachmentHandler({ run, transcribeScript: "/transcribe",
      downloadBuffer: async () => { throw new Error("durable cache was bypassed"); } });
    const prompts = [];
    const reconciler = createInboundReconciler({ store, state: null,
      resolveTarget: () => null,
      onMessage: async (msg) => {
        prompts.push(await attachmentHandler.buildPrompt(msg, []));
        return { delivered: true };
      } });

    expect(await reconciler.drain(channel, "200")).toEqual({ replayed: 1, pending: 0 });
    expect(run).not.toHaveBeenCalled();
    expect(replyTo).not.toHaveBeenCalled();
    expect(prompts).toEqual([expect.stringContaining("journaled transcript")]);
    expect(store.read("200", "210").effects).toMatchObject({
      "transcript-reply": { status },
      "transcript-reply:610": { status: "sent" },
    });
    expect(findMessageByNonce).toHaveBeenCalledTimes(status === "sending" ? 1 : 0);
  });
});
