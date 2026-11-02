import { describe, it, expect, vi } from "vitest";
import { deliverMirror } from "./mirror-worker.mjs";
import { mirrorLine } from "../core/mirror-copy.mjs";
import { discordMessagePayload } from "./send-notify.mjs";
describe("the detached report mirror", () => {
  it("keeps authored numbers and bullets while suppressing link cards", async () => {
    const input = "1. ANDROID-PAKET\n- Första punkten\n2. PLAY-SIDAN\n- Nästa punkt\nhttps://example.org\n```\n1. kod\n```";
    const send = vi.fn(async () => []);
    await deliverMirror({ channelId: "channel", content: input }, send);
    const text = send.mock.calls[0][1];
    expect(text).toBe("1\\. ANDROID-PAKET\n- Första punkten\n2\\. PLAY-SIDAN\n- Nästa punkt\nhttps://example.org\n```\n1. kod\n```");
    expect(discordMessagePayload(text, null, true)).toMatchObject({ content: text, flags: 4 });
    expect(discordMessagePayload("ordinary", null, false)).not.toHaveProperty("flags");
  });
  it("forwards one concise line with the real stable queue identity", async () => {
    const send = vi.fn(async () => [{ id: "post" }]);
    const text = "[from lsrc:4]\n\nSUMMARY: " + "x".repeat(180) + "\nDONE: private details";
    const content = mirrorLine({ sender: "lsrc:4", target: "skyvw:0", text });
    await deliverMirror({ channelId: "channel", content, idempotencyKey: "mirror:job-1" }, send);
    expect(send).toHaveBeenCalledExactlyOnceWith("channel", content, { kind: "mirror", idempotencyKey: "mirror:job-1" });
    expect(content).toBe("lsrc:4 → skyvw:0: " + "x".repeat(119) + "…");
    expect(content).not.toMatch(/\n|DONE:/u);
  });
});
