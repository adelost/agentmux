import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { readCodexQuotaBudgeted } from "./codex-quota-budget.mjs";

feature("Codex dashboard quota budget", () => {
  unit("native and dashboard profile shapes share the authenticated quota cache", {
    given: ["one fake account, with and without the dashboard credentialsPath field", () => {
      const home = mkdtempSync(join(tmpdir(), "codex-quota-identity-"));
      const credentialsPath = join(home, "auth.json");
      writeFileSync(credentialsPath, JSON.stringify({ tokens: { account_id: "fake-provider-account" } }));
      return { home, credentialsPath, budgetDir: join(home, "budget"), read: vi.fn(async () => ({ ok: true, limits: [{ limitId: "codex",
        windows: [{ windowMinutes: 10080, usedPercent: 100 }] }] })) };
    }],
    when: ["the dashboard writes and delivery checks the native profile without refreshing", async fx => {
      const dashboard = await readCodexQuotaBudgeted({ id: "2", home: fx.home, credentialsPath: fx.credentialsPath }, fx);
      const delivery = await readCodexQuotaBudgeted({ id: "2", home: fx.home }, { ...fx, cacheOnly: true });
      return { fx, dashboard, delivery };
    }],
    then: ["the verified exhausted observation is shared without another provider call", ({ fx, dashboard, delivery }) => {
      expect(delivery).toEqual(dashboard); expect(fx.read).toHaveBeenCalledTimes(1);
    }],
    cleanup: fx => rmSync(fx.home, { recursive: true, force: true }),
  });
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
