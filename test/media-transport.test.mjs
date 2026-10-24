import { afterEach, expect, it, vi } from "vitest";
vi.mock("../channels/post-ledger.mjs", () => ({ recordDiscordPost: vi.fn() }));
import { sendFileToChannelId } from "../cli/send-notify.mjs";
const originalToken = process.env.DISCORD_TOKEN;
afterEach(() => { vi.unstubAllGlobals(); if (originalToken === undefined) delete process.env.DISCORD_TOKEN; else process.env.DISCORD_TOKEN = originalToken; });

it("uses one multipart POST with the exact MP4 bytes, MIME and nonce", async () => {
  process.env.DISCORD_TOKEN = "fixture-token";
  const bytes = Buffer.from("unchanged clip bytes");
  const fetch = vi.fn(async (_url, options) => {
    expect(options.method).toBe("POST");
    const file = options.body.get("files[0]"), payload = JSON.parse(options.body.get("payload_json"));
    expect(file.type).toBe("video/mp4"); expect(Buffer.from(await file.arrayBuffer()).equals(bytes)).toBe(true);
    expect(payload).toMatchObject({ content: "Caption", nonce: "one-intent", enforce_nonce: true });
    return { ok: true, json: async () => ({ id: "posted", attachments: [] }) };
  });
  vi.stubGlobal("fetch", fetch);
  expect(await sendFileToChannelId("target", "/isolated/clip.mp4", "Caption", { fileBuffer: bytes, contentType: "video/mp4", nonce: "one-intent" })).toMatchObject({ id: "posted" });
  expect(fetch).toHaveBeenCalledOnce();
});

it.each([[413, true], [500, false]])("classifies HTTP %s without retrying the POST", async (status, notSent) => {
  process.env.DISCORD_TOKEN = "fixture-token";
  const fetch = vi.fn(async () => ({ ok: false, status, text: async () => "file rejected" }));
  vi.stubGlobal("fetch", fetch);
  let error;
  try { await sendFileToChannelId("target", "/isolated/clip.mp4", "", { fileBuffer: Buffer.from("clip") }); }
  catch (caught) { error = caught; }
  expect(error.notSent).toBe(notSent); expect(fetch).toHaveBeenCalledOnce();
});
