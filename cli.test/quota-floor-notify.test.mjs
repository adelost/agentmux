import { afterEach, describe, it, expect, vi } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

afterEach(() => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); });
describe("the quota-floor human notice never falls back after an unknown message send", () => {
  it("keeps a lost DM response unknown instead of sending a second message", async () => {
    const home = mkdtempSync(join(tmpdir(), "quota-notice-"));
    mkdirSync(join(home, ".openclaw"));
    writeFileSync(join(home, ".openclaw/.channel-cache.json"), JSON.stringify({ notify: "fallback" }));
    vi.stubEnv("HOME", home); vi.stubEnv("DISCORD_TOKEN", "synthetic");
    const posts = [];
    vi.stubGlobal("fetch", async (url) => {
      if (url.endsWith("users/@me/channels")) return { ok: true, json: async () => ({ id: "dm" }) };
      posts.push(url);
      if (url.includes("/dm/")) throw Error("response lost after Discord accepted the message");
      return { ok: true, json: async () => ({ id: "unwanted-second-message" }) };
    });
    const { notifyUser } = await import("../cli/send-notify.mjs?quota-floor-unknown");
    const result = await notifyUser("Quota held", { userId: "synthetic-user", strictSingleAttempt: true,
      idempotencyKey: "quota-floor:synthetic:episode:human" });
    expect(result).toMatchObject({ sent: false, outcome: "unknown" });
    expect(posts).toHaveLength(1);
  });
});
