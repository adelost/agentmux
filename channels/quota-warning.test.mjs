import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feature, unit, expect } from "bdd-vitest";
import { afterAll, vi } from "vitest";
import { createSentNoticeStore, parseQuotaWarningConfig, postDueQuotaWarnings } from "./quota-warning.mjs";

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
  { ...account("codex", "wetterlind", 100, [], "2026-10-22T09:28:56Z"), profile: { id: "2" } },
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
const posted = async (snapshot, now = NOW) => {
  const fx = fixture();
  await postDueQuotaWarnings({ snapshot, sent: fx.sent, notify: fx.notify, now });
  return fx.notify.mock.calls.map(call => call[0]);
};

// Which accounts may trigger a notice: Mattias via skyvw:0 07:18Z. What it says: lsrc:0's quota box for Mattias, later that day.
feature("active-account warning with the quota box, 2026-10-17", () => {
  unit("09:15 posts once for Codex A and gives inactive ai:2 no advice", {
    when: ["rendering the original readings with measured inactivity", () => posted(morning())],
    then: ["one box; the idle ai:2 account gets a row but no advice", texts => expect(texts).toEqual([[
      "```",
      "               week  reset",
      "● Codex A       19%  Thu 08:13",
      "○ Codex W        0%  Thu 11:29",
      "● Claude W (2)  93%  Wed 02:00",
      "● Claude A (1)   5%  Wed 02:00",
      "```",
      "→ Free reset Codex A at 100%",
    ].join("\n")])],
  });
  unit("09:15 moves ai:2 to wetterlind when ai:2 is active", {
    when: ["ai:2 has actually worked in the last hour", () => posted(morning(true))],
    then: ["still one overview, and its advice is the exact switch", texts => {
      expect(texts).toHaveLength(1);
      expect(texts[0].split("\n").at(-1)).toBe("→ Use Claude W: /byt wetterlind");
      expect(texts[0]).not.toMatch(/1\+2|Free reset|other/u);
    }],
  });
  unit("unknown activity, stopped-only and green accounts produce no warning", {
    when: ["no account qualifies", () => posted({ accounts: [
      { ...account("claude", "unknown", 95), activeInUse: undefined },
      account("claude", "stopped", 100, []), account("codex", "green", 79),
    ] })],
    then: ["there is no message", texts => expect(texts).toEqual([])],
  });
  unit("safe pace keeps the overview but suggests nothing", {
    when: ["80 percent accumulated over six days", () => posted({ accounts: [
      account("claude", "adelost", 80), account("claude", "spare", 17, []),
    ] }, Date.parse(RESET) - 24 * HOUR)],
    then: ["the week lasts until its reset, so the box ends with the table", ([text]) => expect(text.split("\n").slice(2))
      .toEqual(["● Claude A  20%  Wed 02:00", "○ Claude S  83%  Wed 02:00", "```"])],
  });
  unit("a spare at the warning level never receives a switch suggestion", {
    when: ["only the alternate account is at 80 percent", () => posted({ accounts: [
      account("claude", "adelost", 95), account("claude", "spare", 80, []),
    ] })],
    then: ["the advice is the free reset, not /byt", ([text]) => expect(text.split("\n").at(-1)).toBe("→ Free reset Claude A at 100%")],
  });
  unit("a full account in use says it is used up and to reset now", {
    when: ["16 panes have just reached the weekly limit", () => posted({ accounts: [
      account("claude", "mattias.wetterlind", 100, Array.from({ length: 16 }, (_, i) => `test:${i}`)),
    ] })],
    then: ["the stop is explicit", ([text]) => expect(text.split("\n").slice(2)).toEqual([
      "● Claude W   0%  Wed 02:00",
      "```",
      "→ Free reset Claude W now",
    ])],
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
      expect(fx.notify.mock.calls[1][0]).toContain("→ Free reset Claude A now");
    }],
  });
  unit("the background check emits only newly full accounts", {
    when: ["a background check sees 95 percent then 100", async () => {
      const fx = fixture(); await fx.check(95, NOW, { fullOnly: true }); await fx.check(100, NOW + 1_000, { fullOnly: true }); return fx;
    }],
    then: ["the full account gets one warning without a human message", fx => {
      expect(fx.notify).toHaveBeenCalledTimes(1); expect(fx.notify.mock.calls[0][0]).toContain("→ Free reset Claude A now");
    }],
  });
  unit("another account's first warning posts the whole overview again", {
    when: ["one account remains inside its cooldown and a second one warns", async () => {
      const fx = fixture(); await fx.check(95);
      await postDueQuotaWarnings({ snapshot: { accounts: [account("claude", "adelost", 95), account("codex", "other", 85)] },
        sent: fx.sent, notify: fx.notify, now: NOW + 1_000 }); return fx;
    }],
    then: ["the second post shows both engines", fx => {
      expect(fx.notify).toHaveBeenCalledTimes(2);
      expect(fx.notify.mock.calls[1][0]).toMatch(/\n● Codex O   15%  Wed 02:00\n● Claude A   5%  Wed 02:00\n/u);
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
