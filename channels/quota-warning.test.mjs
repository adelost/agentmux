import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { createSentNoticeStore, parseQuotaWarningConfig, postDueQuotaWarnings } from "./quota-warning.mjs";

const NOW = Date.parse("2026-10-16T12:00:00Z"), HOUR = 3_600_000;
const RESET = "2026-10-21T00:00:00Z";
const account = (provider, id, usedPercent, inUse = ["test:0"], email = `${id}@example.test`) => ({ ok: true, provider,
  profile: { id }, account: { email }, inUse,
  limits: provider === "claude" ? [{ kind: "weekly_all", usedPercent, resetsAt: RESET }]
    : [{ limitId: "codex", windows: [{ windowMinutes: 10080, usedPercent, resetsAt: RESET }] }],
});

function fixture(provider = "claude") {
  const path = join(mkdtempSync(join(tmpdir(), "quota-warning-")), "sent.json");
  const notify = vi.fn(async () => {});
  // Each check opens the store afresh, as a restarted bridge would.
  const check = (used, now = NOW, { inUse = ["test:0"], spare = 17, accounts } = {}) => postDueQuotaWarnings({
    snapshot: { accounts: accounts || [account(provider, "1", used, inUse), account(provider, "2", spare, [])] },
    notify, sent: createSentNoticeStore(path), now, config: parseQuotaWarningConfig({}),
  });
  return { check, notify };
}
const percents = fx => fx.notify.mock.calls.map(([text]) => [...text.matchAll(/(\d+) % av veckan/gu)].map(m => m[1]));

feature("quota warnings shown where the human writes", () => {
  unit("from 80 % a warning comes at most every 6 hours, also across a bridge restart", {
    given: ["an account a pane runs on", () => fixture()],
    when: ["the human writes at 79, 80, 85 a second before 6 h, and 86 at 6 h", async fx => {
      await fx.check(79, NOW - HOUR); await fx.check(80); await fx.check(85, NOW + 6 * HOUR - 1_000);
      await fx.check(86, NOW + 6 * HOUR); return fx;
    }],
    then: ["two warnings, each with the plan and the confirm command", fx => {
      expect(percents(fx)).toEqual([["80"], ["86"]]);
      expect(fx.notify.mock.calls[0][0]).toContain("`/byt 2@example.test` visar planen, `/byt 2@example.test ok` byter.");
    }],
  });

  unit("from 90 % the wait is 3 hours", {
    given: ["an account a pane runs on", () => fixture()],
    when: ["the human writes at 90, 95 a second before 3 h, and 96 at 3 h", async fx => {
      await fx.check(90); await fx.check(95, NOW + 3 * HOUR - 1_000); await fx.check(96, NOW + 3 * HOUR); return fx;
    }],
    then: ["two warnings", fx => expect(percents(fx)).toEqual([["90"], ["96"]])],
  });

  unit("a reached limit still warns, an account without panes never does", {
    given: ["two stores", () => ({ full: fixture(), idle: fixture() })],
    when: ["one account is at 100 % and another at 95 % with no pane", async fx => {
      await fx.full.check(100); await fx.idle.check(95, NOW, { inUse: [] }); return fx;
    }],
    then: ["only the used account warns", fx => {
      expect(percents(fx.full)).toEqual([["100"]]);
      expect(fx.idle.notify).not.toHaveBeenCalled();
    }],
  });

  unit("Codex names the free slot's switch and the channel to type it in", {
    given: ["a Codex account a pane runs on", () => fixture("codex")],
    when: ["it reaches 82 %", fx => fx.check(82).then(() => fx)],
    then: ["the warning gives slot 2's switch command", fx => {
      expect(fx.notify.mock.calls[0][0]).toMatch(/Codex 1@example\.test: 82 % av veckan, reset/u);
      expect(fx.notify.mock.calls[0][0]).toContain("`//switch 2` i kanalen för test:0.");
    }],
  });

  unit("without an account below 80 % the warning is one line", {
    given: ["an account a pane runs on", () => fixture()],
    when: ["the only other account is at 80 %", fx => fx.check(85, NOW, { spare: 80 }).then(() => fx)],
    then: ["no switch is suggested", fx => {
      const lines = fx.notify.mock.calls[0][0].split("\n");
      expect(lines).toHaveLength(2);
      expect(lines[1]).toMatch(/^Claude 1@example\.test: 85 %.*Inget annat Claude-konto har plats under 80 %\.$/u);
    }],
  });

  unit("several due accounts arrive in one message", {
    given: ["a store", () => fixture()],
    when: ["a Claude and a Codex account are due at the same time", fx => fx.check(0, NOW, { accounts: [
      account("claude", "1", 84, ["lsrc:0"], "a@example.test"),
      account("codex", "1", 100, ["skybar:4"], "b@example.test"),
      account("codex", "2", 45, [], "a@example.test"),
    ] }).then(() => fx)],
    then: ["one post carries both", fx => {
      expect(fx.notify).toHaveBeenCalledTimes(1);
      expect(fx.notify.mock.calls[0][0]).toMatch(/^⚠️ \*\*Kontokvot\*\*\nClaude a@example\.test: 84 %.*\nCodex b@example\.test: 100 %/su);
    }],
  });
});
