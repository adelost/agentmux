import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { readCodexQuotaBudgeted } from "./codex-quota-budget.mjs";

feature("Codex dashboard quota budget", () => {
  unit("a reminder reuses the dashboard reading and never refreshes the provider", {
    given: ["a dashboard reader and a separate persisted cache", () => ({
      profile: { provider: "codex", id: "1", home: "/example/codex" },
      budgetDir: mkdtempSync(join(tmpdir(), "codex-quota-budget-")),
      read: vi.fn(async () => ({ ok: true, observation: { usedPercent: 91 } })),
    })],
    when: ["a cold reminder, dashboard, warm reminder and expired reminder read", async fx => {
      const cold = await readCodexQuotaBudgeted(fx.profile, { ...fx, cacheOnly: true, now: () => 0 });
      const dashboard = await readCodexQuotaBudgeted(fx.profile, { ...fx, now: () => 0 });
      const warm = await readCodexQuotaBudgeted(fx.profile, { ...fx, cacheOnly: true, now: () => 1 });
      const expired = await readCodexQuotaBudgeted(fx.profile, { ...fx, cacheOnly: true, now: () => 900000 });
      return { fx, cold, dashboard, warm, expired };
    }],
    then: ["only the dashboard spends a read, and stale data is refused", ({ fx, cold, dashboard, warm, expired }) => {
      expect(fx.read).toHaveBeenCalledTimes(1);
      expect(cold.error).toBe("quota_cache_unavailable");
      expect(warm).toEqual(dashboard);
      expect(expired.error).toBe("quota_cache_unavailable");
    }],
  });
});
