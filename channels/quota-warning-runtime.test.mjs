import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { readReminderSnapshot } from "./quota-warning-runtime.mjs";
vi.mock("../core/quota-usage.mjs", () => ({ readQuotaSnapshot: vi.fn(async () => ({ accounts: [] })) }));
vi.mock("../core/quota-in-use.mjs", () => ({ readQuotaSnapshotWithPanes: async ({ readSnapshot }) => readSnapshot() }));
vi.mock("../core/quota-profiles.mjs", () => ({ quotaAccountCatalog: () => [
  { provider: "claude" }, { provider: "codex" }, { provider: "kimi" },
] }));
import { readQuotaSnapshot } from "../core/quota-usage.mjs";

feature("human-only reminder runtime", () => {
  unit("the warning snapshot cannot add provider requests", {
    when: ["reading the shared snapshot", () => readReminderSnapshot()],
    then: ["both providers are cache-only and unrelated providers are omitted", () => {
      expect(readQuotaSnapshot).toHaveBeenCalledWith({ profiles: [{ provider: "claude" }, { provider: "codex" }],
        claude: { cacheOnly: true }, codex: { cacheOnly: true } });
    }],
  });
});
