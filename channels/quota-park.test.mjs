import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createQuotaParkFacts } from "./quota-park.mjs";

// lsrc:0 2026-10-19: a pane quota recovery moved to an account with room keeps working under the floor,
// even while the five-minute snapshot still lists it on the account it left.
feature("which account a pane's quota facts come from", () => {
  unit("wind-down receives provider reading time and candidate accounts, never cache refresh time", {
    given: ["a snapshot read now containing an older provider observation", () => ({ accounts: [{ ok: true, provider: "claude",
      name: "Claude S", profile: { key: "claude:1" }, inUse: ["claw:1"], limits: [],
      observation: { observedAt: "2026-10-20T10:03:32Z" } }] })],
    when: ["reading the pane facts", async snapshot => ({ snapshot, facts: await createQuotaParkFacts({ read: async () => snapshot,
      profiles: () => [], now: () => Date.parse("2026-10-20T10:07:10Z") })("claw:1") })],
    then: ["the provider time survives with the shared candidate snapshot", ({ snapshot, facts }) => {
      expect(facts.observedAt).toBe(Date.parse("2026-10-20T10:03:32Z"));
      expect(facts.accounts).toEqual(snapshot.accounts);
    }],
  });
  unit("a fresh read follows the pane to the account it runs on now; the cached read keeps the snapshot", {
    given: ["claw:1 listed on Claude S at 97 %, now running from Claude A's home", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-quota-facts-"));
      const homeS = mkdtempSync(join(root, "s-")), homeA = mkdtempSync(join(root, "a-"));
      const week = (usedPercent) => [{ kind: "weekly_all", usedPercent, resetsAt: "2026-10-20T04:00:00Z" }];
      const snapshot = { accounts: [
        { ok: true, provider: "claude", name: "Claude S", profile: { key: "claude:1" }, limits: week(97), inUse: ["claw:1"] },
        { ok: true, provider: "claude", name: "Claude A", profile: { key: "claude:2" }, limits: week(40), inUse: [] },
      ] };
      const facts = createQuotaParkFacts({ read: async () => snapshot, log: () => {},
        readPanes: async () => [{ key: "claw:1", engine: "claude", home: homeA }],
        profiles: () => [{ key: "claude:1", provider: "claude", home: homeS }, { key: "claude:2", provider: "claude", home: homeA }] });
      return { root, facts };
    }],
    when: ["reading claw:1 cached, then fresh", async ({ facts }) => [await facts("claw:1"), await facts("claw:1", { fresh: true })]],
    // The provider tells the floor a Codex account, which works on past a spent window on paid credits (lsrc:0 2026-10-20).
    then: ["Claude S from the snapshot, Claude A from the live home, each with its provider", ([cached, fresh], { root }) => {
      try {
        expect(cached).toMatchObject({ account: { name: "Claude S", key: "claude:1", provider: "claude" },
          windows: [expect.objectContaining({ kind: "week", usedPercent: 97 })] });
        expect(fresh).toMatchObject({ account: { name: "Claude A", key: "claude:2", provider: "claude" },
          windows: [expect.objectContaining({ kind: "week", usedPercent: 40 })] });
      } finally { rmSync(root, { recursive: true, force: true }); }
    }],
  });
});
