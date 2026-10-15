import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { createSentNoticeStore, parseQuotaWarningConfig, runQuotaWarningTick, weeklyWindowKey } from "./quota-warning.mjs";

const NOW = Date.parse("2026-10-15T11:00:00Z"), HOUR = 3_600_000;
const RESET = "2026-10-21T11:00:00Z";
const account = (provider, id, usedPercent, inUse = ["test:0"]) => ({ ok: true, provider,
  profile: { id }, account: { email: `${id}@example.test` }, inUse,
  limits: provider === "claude" ? [{ kind: "weekly_all", usedPercent, resetsAt: RESET }]
    : [{ limitId: "codex", windows: [{ windowMinutes: 10080, usedPercent, resetsAt: RESET }] }],
});

function fixture(provider = "claude") {
  const path = join(mkdtempSync(join(tmpdir(), "quota-reminder-")), "sent.json");
  const notify = vi.fn(async () => ({ sent: true })), deliverActor = vi.fn();
  const run = (used, now = NOW, inUse = ["test:0"], spare = 17) => runQuotaWarningTick({
    snapshot: { accounts: [account(provider, "1", used, inUse), account(provider, "2", spare, [])] },
    accountsInUse: () => inUse.length ? [{ email: "1@example.test", profile: { id: "1" } }] : [],
    allAccounts: () => [{ email: "2@example.test", profile: { id: "2" } }],
    readQuota: async profile => account(provider, profile.id, profile.id === "1" ? used : spare),
    historyOf: () => [],
    notify, deliverActor, sent: createSentNoticeStore(path), now,
    config: parseQuotaWarningConfig({ AMUX_QUOTA_WARN_ACTOR: "api:0" }),
  });
  return { path, run, notify, deliverActor };
}

feature("active subscription reserve reminders", () => {
  unit("Claude growth gets at most one reminder per hour, including after a restart", {
    given: ["a durable store with a growing active Claude account", () => fixture()],
    when: ["usage rises and then stops across fresh store instances", async fx => {
      await fx.run(90, NOW - HOUR); await fx.run(91);
      await fx.run(92, NOW + HOUR - 1); await fx.run(93, NOW + HOUR);
      await fx.run(93, NOW + 2 * HOUR); return fx;
    }],
    then: ["only two quiet human prompts with explicit plan and confirmation commands", fx => {
      expect(fx.notify).toHaveBeenCalledTimes(2);
      expect(fx.notify.mock.calls.map(([text]) => text.split("\n").length)).toEqual([2, 2]);
      expect(fx.notify.mock.calls[0][0]).toContain("/byt 2@example.test");
      expect(fx.notify.mock.calls[0][0]).toContain("/byt 2@example.test ok");
      expect(fx.notify.mock.calls[0][1].level).toBe("info");
      expect(fx.deliverActor).not.toHaveBeenCalled();
    }],
  });

  unit("an account with no running pane never prompts", {
    given: ["a Claude baseline", () => fixture()],
    when: ["usage increases but its last pane has stopped", async fx => {
      await fx.run(90, NOW - HOUR); await fx.run(91, NOW, []); return fx;
    }],
    then: ["neither a human nor a panel is contacted", fx => {
      expect(fx.notify).not.toHaveBeenCalled(); expect(fx.deliverActor).not.toHaveBeenCalled();
    }],
  });

  unit("Codex uses its weekly window and the target slot's Discord switch command", {
    given: ["an active Codex account with a spare slot", () => fixture("codex")],
    when: ["weekly usage reaches 91 percent", async fx => {
      await fx.run(90, NOW - HOUR); await fx.run(91); return fx;
    }],
    then: ["one human prompt names the slot without waking a panel", fx => {
      expect(fx.notify).toHaveBeenCalledTimes(1);
      expect(fx.notify.mock.calls[0][0]).toMatch(/Codex 1@example.test: 91 %.*reset/u);
      expect(fx.notify.mock.calls[0][0]).toContain("//switch 2");
      expect(fx.deliverActor).not.toHaveBeenCalled();
    }],
  });

  unit("stationary usage after a fresh bridge start sends nothing", {
    given: ["no earlier observations", () => fixture()],
    when: ["a stationary account is observed two hours apart", async fx => {
      await fx.run(91); await fx.run(91, NOW + 2 * HOUR); return fx;
    }],
    then: ["a baseline alone cannot cause a prompt", fx => expect(fx.notify).not.toHaveBeenCalled()],
  });

  unit("upgrading an old reserve receipt starts a conservative hourly cooldown", {
    given: ["a reserve notice recorded by the previous release", () => {
      const fx = fixture();
      writeFileSync(fx.path, JSON.stringify({ [weeklyWindowKey("1@example.test", RESET)]: {
        levels: ["threshold", "urgent", "reserve"], expiresAt: Date.parse(RESET) + HOUR,
      } }));
      return fx;
    }],
    when: ["usage grows during and after the first hour", async fx => {
      await fx.run(91); await fx.run(92, NOW + HOUR - 1); await fx.run(93, NOW + HOUR); return fx;
    }],
    then: ["the prior notice cannot be followed by an immediate duplicate", fx => expect(fx.notify).toHaveBeenCalledTimes(1)],
  });

  unit("no spare capacity is explained in one line", {
    given: ["an active account", () => fixture()],
    when: ["it grows with all other accounts at reserve", async fx => {
      await fx.run(90, NOW - HOUR); await fx.run(91, NOW, ["test:0"], 90); return fx;
    }],
    then: ["the human gets one line with no switch command", fx => {
      expect(fx.notify).toHaveBeenCalledTimes(1);
      expect(fx.notify.mock.calls[0][0]).toMatch(/Inget annat Claude-konto.*90 %/u);
      expect(fx.notify.mock.calls[0][0]).not.toMatch(/\n|byt|switch|rotate/u);
      expect(fx.deliverActor).not.toHaveBeenCalled();
    }],
  });
});
