import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feature, unit, expect } from "bdd-vitest";
import { afterAll, vi } from "vitest";
import { createSentNoticeStore, formatQuotaWarning, parseQuotaWarningConfig, postDueQuotaWarnings } from "./quota-warning.mjs";

vi.stubEnv("TZ", "Europe/Stockholm");
afterAll(() => vi.unstubAllEnvs());
const NOW = Date.parse("2026-10-17T07:15:23.569Z"), HOUR = 3_600_000;
const RESET = "2026-10-21T00:00:00Z";
const account = (provider, login, usedPercent, activeInUse = ["test:0"], reset = RESET) => ({
  ok: true, provider, profile: { id: provider === "codex" ? "1" : "2" },
  sharedBy: [{ id: "1" }, { id: "2" }], account: { email: `${login}@example.test` },
  inUse: activeInUse, activeInUse,
  limits: provider === "claude" ? [{ kind: "weekly_all", usedPercent, resetsAt: reset }]
    : [{ limitId: "codex", windows: [{ windowMinutes: 10080, usedPercent, resetsAt: reset }] }],
});
// Readings and pane ownership from Discord 1560914120436613223, 09:15 CEST.
// Activity is varied explicitly; the original warning did not measure it.
const morning = (aiActive = false) => ({ accounts: [
  account("codex", "adelost", 81, ["lsrc:7", "lsrc:3"], "2026-10-22T06:13:29Z"),
  account("codex", "wetterlind", 100, [], "2026-10-22T09:28:56Z"),
  { ...account("claude", "adelost", 95, aiActive ? ["ai:2"] : [], "2026-10-20T23:59:59Z"), inUse: ["ai:2"] },
  account("claude", "mattias.wetterlind", 7, ["skyvw:0", "claw:2"]),
  { ok: false, provider: "claude", account: { email: "other@example.test" }, error: "login_expired", inUse: [] },
] });
function fixture() {
  const sent = createSentNoticeStore(join(mkdtempSync(join(tmpdir(), "quota-warning-")), "sent.json"));
  const notify = vi.fn(async () => {});
  const check = (used, now = NOW, options = {}) => postDueQuotaWarnings({
    snapshot: { accounts: [account("claude", "adelost", used, options.panes ?? ["test:0"])] },
    sent, notify, now, ...options,
  });
  return { sent, notify, check };
}

feature("active-account warning, Mattias via skyvw:0 2026-10-17", () => {
  unit("09:15 warns only about Codex adelost when ai:2 is inactive", {
    when: ["rendering the original readings with measured inactivity", () => formatQuotaWarning(morning(), { now: NOW })],
    then: ["one short Swedish line, no overview or reset assumption", text => expect(text).toBe(
      "⚠️ Codex adelost: 81 %, slut ca 17 okt 20:45, nollställs 22 okt 08:13, 2 aktiva paneler.")],
  });
  unit("09:15 includes ai:2's account only when ai:2 is active", {
    when: ["ai:2 has actually worked in the last hour", () => formatQuotaWarning(morning(true), { now: NOW })],
    then: ["Claude has one row and only an eligible same-provider switch", text => {
      const lines = text.split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toMatch(/^⚠️ Claude adelost: 95 %, slut ca 17 okt 13:25, nollställs 21 okt 01:59, 1 aktiv panel\.$/u);
      expect(lines[1]).toBe("Byt till Claude wetterlind: `/byt mattias.wetterlind@example.test`.");
      expect(lines[2]).toContain("Codex adelost: 81 %");
      expect(text).not.toMatch(/1\+2|Codex 1|free|gratis|↳|ai:2|Logged out|7 %/u);
    }],
  });
  unit("unknown activity, stopped-only and green accounts produce no warning", {
    when: ["no account qualifies", () => formatQuotaWarning({ accounts: [
      { ...account("claude", "unknown", 95), activeInUse: undefined },
      account("claude", "stopped", 100, []), account("codex", "green", 79),
    ] }, { now: NOW })],
    then: ["there is no message", text => expect(text).toBe("")],
  });
  unit("safe pace keeps the quota row but suggests no switch", {
    when: ["80 percent accumulated over six days", () => formatQuotaWarning({ accounts: [
      account("claude", "adelost", 80), account("claude", "spare", 17, []),
    ] }, { now: Date.parse(RESET) - 24 * HOUR })],
    then: ["the row reports exhaustion beyond reset without advice", text => {
      expect(text).toContain("Claude adelost: 80 %"); expect(text).not.toContain("/byt");
    }],
  });
  unit("a spare at the warning level never receives a switch suggestion", {
    when: ["only the alternate account is at 80 percent", () => formatQuotaWarning({ accounts: [
      account("claude", "adelost", 95), account("claude", "spare", 80, []),
    ] }, { now: NOW })],
    then: ["one row without a switch", text => { expect(text.split("\n")).toHaveLength(1); expect(text).not.toContain("/byt"); }],
  });
  unit("full accounts lead with a clear stop and active count", {
    when: ["16 panes have just reached the weekly limit", () => formatQuotaWarning({ accounts: [
      account("claude", "mattias.wetterlind", 100, Array.from({ length: 16 }, (_, i) => `test:${i}`)),
    ] }, { now: NOW })],
    then: ["the quota stop is explicit", text => expect(text).toBe(
      "🚫 Claude wetterlind: 100 %, kvoten är slut, nollställs 21 okt 02:00, 16 aktiva paneler.")],
  });
});

feature("account warning cooldown and reached-limit delivery", () => {
  for (const [used, hours] of [[80, 6], [90, 3]]) unit(`${used} percent retains the ${hours} hour cooldown across restart`, {
    when: ["checking before and at the deadline with fresh store instances", async () => {
      const fx = fixture(); await fx.check(used); await fx.check(used + 1, NOW + hours * HOUR - 1);
      await fx.check(used + 2, NOW + hours * HOUR); return fx;
    }],
    then: ["two accepted messages", fx => expect(fx.notify).toHaveBeenCalledTimes(2)],
  });
  unit("100 percent bypasses a 95 percent reminder immediately, only once", {
    when: ["the account reaches its limit within the three-hour cooldown", async () => {
      const fx = fixture(); await fx.check(95); await fx.check(100, NOW + 1_000); await fx.check(100, NOW + 2_000); return fx;
    }],
    then: ["a distinct reached-limit warning is delivered immediately", fx => {
      expect(fx.notify).toHaveBeenCalledTimes(2);
      expect(fx.notify.mock.calls[1][0]).toContain("100 %, kvoten är slut");
    }],
  });
  unit("the background check emits only newly full accounts", {
    when: ["a background check sees 95 percent then 100", async () => {
      const fx = fixture(); await fx.check(95, NOW, { fullOnly: true }); await fx.check(100, NOW + 1_000, { fullOnly: true }); return fx;
    }],
    then: ["the full account gets one warning without a human message", fx => {
      expect(fx.notify).toHaveBeenCalledTimes(1); expect(fx.notify.mock.calls[0][0]).toContain("100 %");
    }],
  });
  unit("only due accounts are included in a post", {
    when: ["one account remains inside its cooldown", async () => {
      const fx = fixture(); await fx.check(95);
      await postDueQuotaWarnings({ snapshot: { accounts: [account("claude", "adelost", 95), account("codex", "other", 85)] },
        sent: fx.sent, notify: fx.notify, now: NOW + 1_000 }); return fx;
    }],
    then: ["the second post contains only the new account", fx => {
      expect(fx.notify.mock.calls[1][0]).toContain("Codex other"); expect(fx.notify.mock.calls[1][0]).not.toContain("Claude adelost");
    }],
  });
  unit("disabled, inactive, unknown and expired readings never post", {
    when: ["checking invalid warning candidates", async () => {
      const fx = fixture(); await fx.check(95, NOW, { panes: [] });
      await fx.check(undefined); await fx.check(100, Date.parse(RESET));
      await fx.check(100, NOW, { config: parseQuotaWarningConfig({ AMUX_QUOTA_WARNING_ENABLED: "false" }) }); return fx;
    }],
    then: ["the notifier is untouched", fx => expect(fx.notify).not.toHaveBeenCalled()],
  });
});
