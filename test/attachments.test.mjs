import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { createAttachmentHandler } from "../attachments.mjs";

// --- Test helpers ---

/**
 * Build a normalized ChannelMessage with configurable attachments and a
 * reply() spy so we can assert on what the handler wrote back to the user.
 */
function fakeMsg({ id = "msg1", text = "", attachments = [] } = {}) {
  const replies = [];
  return {
    id,
    text,
    attachments,
    reply: vi.fn(async (content) => { replies.push(content); }),
    _replies: replies,
  };
}

/**
 * Build a handler with every side-effect (exec, download, fs write)
 * faked out. Returns the handler + all spies so tests can assert.
 */
function setup({ transcribeOutput = "hello world", downloadFails = false } = {}) {
  const runCalls = [];
  const writtenFiles = [];
  const downloadCalls = [];

  const run = vi.fn(async (cmd) => {
    runCalls.push(cmd);
    return { stdout: transcribeOutput, stderr: "" };
  });

  const downloadBuffer = vi.fn(async (url) => {
    downloadCalls.push(url);
    if (downloadFails) throw new Error("HTTP 403");
    return Buffer.from("fake audio bytes");
  });

  const writeTmp = vi.fn((path, data) => {
    writtenFiles.push({ path, size: data.length });
  });

  const handler = createAttachmentHandler({
    run,
    transcribeScript: "/fake/transcribe.sh",
    downloadBuffer,
    writeTmp,
  });

  return { handler, run, downloadBuffer, writeTmp, runCalls, writtenFiles, downloadCalls };
}

// --- buildPrompt: plain text with no attachments ---

feature("buildPrompt: plain text only", () => {
  unit("returns raw text unchanged when no attachments", {
    given: ["a text-only message", () => ({ ctx: setup(), msg: fakeMsg({ text: "hello agent" }) })],
    when: ["buildPrompt is called", async ({ ctx, msg }) => ctx.handler.buildPrompt(msg, [])],
    then: ["returns the original text", (result) => {
      expect(result).toBe("hello agent");
    }],
  });

  unit("returns null when the message has no text and no attachments", {
    given: ["an empty message", () => ({ ctx: setup(), msg: fakeMsg({ text: "" }) })],
    when: ["buildPrompt is called", async ({ ctx, msg }) => ctx.handler.buildPrompt(msg, [])],
    then: ["null", (result) => {
      expect(result).toBeNull();
    }],
  });
});

// --- buildPrompt: audio attachments ---

feature("buildPrompt: audio attachment transcription", () => {
  unit("transcribes audio, appends tagged text, and pushes tmp path to cleanup list", {
    given: ["message with a voice note", () => ({
      ctx: setup({ transcribeOutput: "hello claw hur mår du" }),
      msg: fakeMsg({
        id: "m1",
        text: "",
        attachments: [{ id: "a1", name: "voice.ogg", url: "https://cdn/voice.ogg", contentType: "audio/ogg" }],
      }),
      tmpFiles: [],
    })],
    when: ["buildPrompt is called", async ({ ctx, msg, tmpFiles }) =>
      ctx.handler.buildPrompt(msg, tmpFiles)],
    then: ["tagged transcript, download + transcribe ran, tmp file tracked",
      async (result, { ctx, msg, tmpFiles }) => {
        expect(result).toContain("[transcribed voice, may contain speech-to-text errors");
        expect(result).toContain("hello claw hur mår du");
        expect(ctx.downloadCalls).toEqual(["https://cdn/voice.ogg"]);
        expect(ctx.runCalls[0]).toContain("/fake/transcribe.sh");
        expect(ctx.runCalls[0]).toContain("/tmp/discord-voice-m1.ogg");
        expect(tmpFiles).toEqual(["/tmp/discord-voice-m1.ogg"]);
        expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("transcribed voice"));
      }],
  });

  unit("merges user text with the transcription when both exist", {
    given: ["text + voice", () => ({
      ctx: setup({ transcribeOutput: "sätt på kaffe" }),
      msg: fakeMsg({
        id: "m2",
        text: "kort grej",
        attachments: [{ id: "a1", name: "voice.ogg", url: "u", contentType: "audio/ogg" }],
      }),
      tmpFiles: [],
    })],
    when: ["buildPrompt", async ({ ctx, msg, tmpFiles }) =>
      ctx.handler.buildPrompt(msg, tmpFiles)],
    then: ["text first, then the tagged transcript on a new line", (result) => {
      expect(result).toMatch(/^kort grej\n\[transcribed voice/);
      expect(result).toContain("sätt på kaffe");
    }],
  });

  unit("returns null when transcription yields empty text", {
    given: ["empty transcript", () => ({
      ctx: setup({ transcribeOutput: "" }),
      msg: fakeMsg({
        id: "m3",
        attachments: [{ id: "a1", name: "voice.ogg", url: "u", contentType: "audio/ogg" }],
      }),
      tmpFiles: [],
    })],
    when: ["buildPrompt", async ({ ctx, msg, tmpFiles }) =>
      ctx.handler.buildPrompt(msg, tmpFiles)],
    then: ["null and user gets a feedback reply", (result, { msg }) => {
      expect(result).toBeNull();
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("could not transcribe"));
    }],
  });

  unit("returns null and tells the user when the download errors", {
    given: ["download failure", () => ({
      ctx: setup({ downloadFails: true }),
      msg: fakeMsg({
        id: "m4",
        attachments: [{ id: "a1", name: "voice.ogg", url: "u", contentType: "audio/ogg" }],
      }),
      tmpFiles: [],
    })],
    when: ["buildPrompt", async ({ ctx, msg, tmpFiles }) =>
      ctx.handler.buildPrompt(msg, tmpFiles)],
    then: ["null + error reply", (result, { msg }) => {
      expect(result).toBeNull();
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("Transcription failed"));
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("HTTP 403"));
    }],
  });
});

// --- buildPrompt: image and text file attachments ---

feature("buildPrompt: image and text file attachments", () => {
  unit("downloads an image and inlines its tmp path as a marker", {
    given: ["image attachment", () => ({
      ctx: setup(),
      msg: fakeMsg({
        id: "m5",
        text: "what is this",
        attachments: [{ id: "a1", name: "photo.png", url: "u", contentType: "image/png" }],
      }),
      tmpFiles: [],
    })],
    when: ["buildPrompt", async ({ ctx, msg, tmpFiles }) =>
      ctx.handler.buildPrompt(msg, tmpFiles)],
    then: ["text + [image attached: /tmp/...png]", (result, { tmpFiles }) => {
      expect(result).toMatch(/^what is this\n\[image attached: \/tmp\/discord-media-m5-a1\.png\]$/);
      expect(tmpFiles).toHaveLength(1);
      expect(tmpFiles[0]).toMatch(/\.png$/);
    }],
  });

  unit("detects a text file by extension even if contentType is missing", {
    given: ["README.md attachment with no contentType", () => ({
      ctx: setup(),
      msg: fakeMsg({
        id: "m6",
        text: "",
        attachments: [{ id: "a1", name: "README.md", url: "u", contentType: null }],
      }),
      tmpFiles: [],
    })],
    when: ["buildPrompt", async ({ ctx, msg, tmpFiles }) =>
      ctx.handler.buildPrompt(msg, tmpFiles)],
    then: ["downloaded and tagged as [file attached: ...md]", (result) => {
      expect(result).toContain("[file attached:");
      // tmp path keeps the extension so the agent knows what kind of file
      expect(result).toMatch(/\.md\]/);
    }],
  });

  unit("returns null text (no reply) when the image download fails", {
    given: ["image download fails", () => ({
      ctx: setup({ downloadFails: true }),
      msg: fakeMsg({
        id: "m7",
        attachments: [{ id: "a1", name: "photo.png", url: "u", contentType: "image/png" }],
      }),
      tmpFiles: [],
    })],
    when: ["buildPrompt", async ({ ctx, msg, tmpFiles }) =>
      ctx.handler.buildPrompt(msg, tmpFiles)],
    then: ["null + error reply to user", (result, { msg }) => {
      // No text, no attachment path → empty rawText → null
      expect(result).toBeNull();
      expect(msg.reply).toHaveBeenCalledWith(expect.stringContaining("Failed to download"));
    }],
  });
});

// --- buildPrompt: multiple attachments in one message ---

feature("buildPrompt: multiple attachments", () => {
  unit("stacks image + audio transcription into a single prompt", {
    given: ["text + image + voice", () => ({
      ctx: setup({ transcribeOutput: "beskriv bilden" }),
      msg: fakeMsg({
        id: "m8",
        text: "hej",
        attachments: [
          { id: "a1", name: "shot.png", url: "u1", contentType: "image/png" },
          { id: "a2", name: "voice.ogg", url: "u2", contentType: "audio/ogg" },
        ],
      }),
      tmpFiles: [],
    })],
    when: ["buildPrompt", async ({ ctx, msg, tmpFiles }) =>
      ctx.handler.buildPrompt(msg, tmpFiles)],
    then: ["text, image marker, transcript marker — in order", (result, { tmpFiles }) => {
      expect(result).toMatch(/^hej\n\[image attached:[^\]]+\]\n\[transcribed voice[^\]]+\]/);
      expect(result).toContain("beskriv bilden");
      // Both attachments wrote to tmp
      expect(tmpFiles).toHaveLength(2);
    }],
  });
});
