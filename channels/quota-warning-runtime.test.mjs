import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
vi.mock("../core/quota-usage.mjs", () => ({ readQuotaSnapshot: vi.fn(async () => ({ accounts: [] })) }));
vi.mock("../core/quota-in-use.mjs", () => ({ readQuotaSnapshotWithPanes: async ({ readSnapshot }) => readSnapshot() }));
vi.mock("../core/quota-profiles.mjs", () => ({ quotaAccountCatalog: () => [
  { provider: "claude" }, { provider: "codex" }, { provider: "kimi" },
] }));
import { readQuotaSnapshot } from "../core/quota-usage.mjs";
import { createSentNoticeStore } from "./quota-warning.mjs";
import { createQuotaWarningOnWrite, readWarningSnapshot } from "./quota-warning-runtime.mjs";

const due = { accounts: [{ ok: true, provider: "claude", profile: { id: "1" }, account: { email: "a@example.test" },
  inUse: ["lsrc:0"], limits: [{ kind: "weekly_all", usedPercent: 85, resetsAt: new Date(Date.now() + 86_400_000).toISOString() }] }] };
const message = () => ({ send: vi.fn(async () => ({})) });
function hook(readSnapshot = async () => due, env = {}) {
  const sent = createSentNoticeStore(join(mkdtempSync(join(tmpdir(), "quota-hook-")), "sent.json"));
  const log = vi.fn();
  return { log, warn: createQuotaWarningOnWrite({ env, sent, readSnapshot, observe: () => {}, log }) };
}

feature("the quota warning answers the human message", () => {
  unit("the snapshot reads through the shared quota budget, not a cold cache", {
    when: ["reading the warning snapshot", () => readWarningSnapshot()],
    then: ["Claude and Codex share the dashboard budget and other providers are left out", () => {
      expect(readQuotaSnapshot).toHaveBeenCalledWith({ profiles: [{ provider: "claude" }, { provider: "codex" }] });
    }],
  });

  unit("two quick messages get one warning, in the channel written in", {
    given: ["a due account", () => ({ ...hook(), first: message(), second: message() })],
    when: ["two messages arrive together", async fx => { await Promise.all([fx.warn(fx.first), fx.warn(fx.second)]); return fx; }],
    then: ["only the first channel gets the notice", fx => {
      expect(fx.first.send).toHaveBeenCalledTimes(1);
      expect(fx.first.send.mock.calls[0]).toEqual([expect.stringMatching(/^⚠️ \*\*Kontokvot\*\*\nClaude a@example\.test: 85 %/u), { kind: "notice" }]);
      expect(fx.second.send).not.toHaveBeenCalled();
    }],
  });

  unit("a failed quota read is logged and never reaches the delivery", {
    given: ["an unreadable quota", () => ({ ...hook(async () => { throw new Error("quota_read_busy"); }), msg: message() })],
    when: ["the human writes", async fx => ({ ...fx, result: await fx.warn(fx.msg) })],
    then: ["nothing is posted and the reason is in the log", fx => {
      expect(fx.result).toEqual([]);
      expect(fx.msg.send).not.toHaveBeenCalled();
      expect(fx.log).toHaveBeenCalledWith("check failed: quota_read_busy");
    }],
  });

  unit("AMUX_QUOTA_WARNING_ENABLED=false reads nothing", {
    given: ["a disabled warning", () => {
      const readSnapshot = vi.fn(async () => due);
      return { ...hook(readSnapshot, { AMUX_QUOTA_WARNING_ENABLED: "false" }), readSnapshot, msg: message() };
    }],
    when: ["the human writes", async fx => { await fx.warn(fx.msg); return fx; }],
    then: ["no quota read and no post", fx => {
      expect(fx.readSnapshot).not.toHaveBeenCalled();
      expect(fx.msg.send).not.toHaveBeenCalled();
    }],
  });
});
