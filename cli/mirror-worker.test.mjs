import { describe, it, expect, vi } from "vitest";
import { deliverMirror } from "./mirror-worker.mjs";
import { mirrorLine } from "../core/mirror-copy.mjs";
describe("the detached report mirror", () => {
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
