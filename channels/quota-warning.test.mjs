import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feature, unit, expect } from "bdd-vitest";
import { afterAll, vi } from "vitest";

vi.stubEnv("TZ", "Europe/Stockholm");
afterAll(() => vi.unstubAllEnvs());
import { createSentNoticeStore, formatQuotaWarning, parseQuotaWarningConfig, postDueQuotaWarnings } from "./quota-warning.mjs";

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
// Mattias's complete-account view includes the spare too; cooldown checks follow the warned account only.
const percents = fx => fx.notify.mock.calls.map(([text]) => [...text.matchAll(/\*\*(?:Claude|Codex) 1\*\* · 1@example\.test · \*\*(\d+)%\*\* used/gu)].map(m => m[1]));

const today = () => ({ accounts: [
  account("codex", "1", 47, ["lsrc:8", "lsrc:3"], "adelost@example.test"),
  account("codex", "2", 100, ["skybar:4"], "wetterlind@example.test"),
  account("claude", "1", 85, ["skybar:2", "claw:2"], "adelost@example.test"),
  account("claude", "wetterlind", 97, [], "wetterlind@example.test"),
  { ok: false, provider: "claude", profile: { id: "2" }, account: { email: "other@example.test" }, error: "login_expired", inUse: [] },
  { ok: false, provider: "kimi", profile: { id: "1", label: "wetterlind@example.test" }, error: "credentials_expired", inUse: [] },
] });

const liveSnapshot = () => JSON.parse(readFileSync(new URL("./fixtures/quota-warning-20261016.json", import.meta.url), "utf8"));
const LIVE_WARNING = `**Weekly quota** · no action needed
🟢 **Codex 1** · adelost@example.test · **47%** used · resets Oct 22 08:13
↳ api:4, claw:6, lsrc:3–5,8, skybar:4, skydive:3, skyvw:3
🔴 **Codex 2** · wetterlind@example.test · **100%** used · resets Oct 22 11:28
↳ no panes
⚠️ **Claude 1+2** · adelost@example.test · **85%** used · resets Oct 21 02:00
↳ api:0,1, claw:0–2, lsrc:0–2, skybar:0,2, skydive:0,2, skyvw:0,2
🔴 **Claude wetterlind** · wetterlind@example.test · **97%** used · resets Oct 21 09:00
↳ no panes
Logged out: Claude other@example.test · Kimi wetterlind@example.test · Kimi adelost@example.test`;

feature("English Discord quota warning, Mattias 2026-10-16", () => {
  unit("the anonymized 14:18Z snapshot has the requested account blocks in Stockholm local time", {
    when: ["rendering the snapshot with example.test identities", () => formatQuotaWarning(liveSnapshot(), { now: NOW })],
    then: ["the whole message matches the approved shape", text => expect(text).toBe(LIVE_WARNING)],
  });
  unit("Claude action names the plan and limits its approved moves", {
    when: ["the occupied Claude account is at 85% and a spare is below the warning level", () => formatQuotaWarning({ accounts: [
      account("claude", "1", 85), account("claude", "2", 47, [], "adelost@example.test"),
    ] }, { now: NOW })],
    then: ["the first line gives the existing plan and confirmation commands", text => expect(text.split("\n")[0]).toBe(
      "**Weekly quota** · Claude panes are at 85%. `/byt adelost@example.test` shows the plan to Claude 2 adelost@example.test (47%); `/byt adelost@example.test ok` moves only the panes the plan approves. Other panes keep their accounts.")],
  });
  for (const [used, icon] of [[59, "🟢"], [60, "⚠️"], [74, "⚠️"], [75, "🔴"], [null, "⚪"], [undefined, "⚪"]]) {
    unit(`the configured levels render ${String(used)} as ${icon}`, {
      when: ["formatting the configured warning and reserve thresholds", () => formatQuotaWarning({ accounts: [
        account("codex", "1", used, []),
      ] }, { now: NOW, config: parseQuotaWarningConfig({ AMUX_QUOTA_WARN_PERCENT: "60", AMUX_QUOTA_RESERVE_PERCENT: "75" }) })],
      then: ["only a known weekly reading has a severity", text => {
        expect(text.split("\n")[1]).toMatch(new RegExp(`^${icon} `, "u"));
        if (used == null) expect(text).toContain("weekly unknown");
      }],
    });
  }
  unit("all warning fixtures and missing identity or reset fallbacks use English without em dashes", {
    when: ["rendering live, action, unavailable and missing-reading accounts", () => [
      liveSnapshot(), today(), { accounts: [] },
      { accounts: [account("claude", "1", 85), account("claude", "2", 17, [])] },
      { accounts: [{ ok: false, provider: "codex", profile: { id: "1" }, inUse: ["test:0"] }] },
      { accounts: [{ ...account("codex", "1", 20), limits: [{ windows: [{ windowMinutes: 10080, usedPercent: 20, resetsAt: "invalid" }] }] }] },
    ].map(snapshot => formatQuotaWarning(snapshot, { now: NOW }))],
    then: ["no Swedish copy remains and unknown values are explicit", warnings => {
      for (const warning of warnings) expect(warning).not.toMatch(/[åäöÅÄÖ\u2014]/u);
      expect(warnings[4]).toContain("unknown login · weekly unknown · reset unknown");
      expect(warnings[5]).toContain("reset unknown");
    }],
  });
});

feature("complete quota warning, Mattias 2026-10-16", () => {
  unit("a logged-in Kimi account keeps its known weekly reading", {
    when: ["formatting the provider's normalized weekly window", () => formatQuotaWarning({ accounts: [{ ok: true,
      provider: "kimi", profile: { id: "1" }, account: { email: "a@example.test" }, inUse: [],
      limits: [{ kind: "weekly", usedPercent: 21, resetsAt: RESET }],
    }] }, { now: NOW })],
    then: ["the account row shows the reading rather than inventing an unknown quota", text =>
      expect(text).toContain("🟢 **Kimi 1** · a@example.test · **21%** used · resets Oct 21 02:00\n↳ no panes")],
  });
  unit("today's warning names one pane-local action, every account and unused or logged-out logins", {
    when: ["formatting today's account and pane readings", () => formatQuotaWarning(today(), { now: NOW })],
    then: ["the action is first, followed only by one line per account and one logged-out line", text => {
      const lines = text.split("\n");
      expect(lines).toHaveLength(10);
      expect(lines[0]).toBe("**Weekly quota** · **skybar:4** is full. Write `//switch 1` in skybar:4 to move only skybar:4 to Codex 1 adelost@example.test (47%). Other panes keep their accounts.");
      expect(lines[1]).toBe("🟢 **Codex 1** · adelost@example.test · **47%** used · resets Oct 21 02:00");
      expect(lines[2]).toBe("↳ lsrc:3,8");
      expect(lines[3]).toBe("🔴 **Codex 2** · wetterlind@example.test · **100%** used · resets Oct 21 02:00");
      expect(lines[4]).toBe("↳ skybar:4");
      expect(lines[5]).toBe("⚠️ **Claude 1** · adelost@example.test · **85%** used · resets Oct 21 02:00");
      expect(lines[6]).toBe("↳ claw:2, skybar:2");
      expect(lines[7]).toBe("🔴 **Claude wetterlind** · wetterlind@example.test · **97%** used · resets Oct 21 02:00");
      expect(lines[8]).toBe("↳ no panes");
      expect(lines[9]).toBe("Logged out: Claude other@example.test · Kimi wetterlind@example.test");
    }],
  });
  for (const [name, changes] of [
    ["below the warning threshold", snapshot => { snapshot.accounts[1].limits[0].windows[0].usedPercent = 79; }],
    ["no pane on the full account", snapshot => { snapshot.accounts[1].inUse = []; }],
    ["no spare account of the same provider", snapshot => { snapshot.accounts[0].limits[0].windows[0].usedPercent = 80; }],
  ]) unit(`no action when ${name}`, {
    given: [name, () => { const snapshot = today(); changes(snapshot); return snapshot; }],
    when: ["formatting the warning", snapshot => formatQuotaWarning(snapshot, { now: NOW })],
    then: ["the complete account view starts with no action", text => expect(text.split("\n")[0]).toBe("**Weekly quota** · no action needed")],
  });
});

feature("quota warnings shown where the human writes", () => {
  unit("from 80 % a warning comes at most every 6 hours, also across a bridge restart", {
    given: ["an account a pane runs on", () => fixture()],
    when: ["the human writes at 79, 80, 85 a second before 6 h, and 86 at 6 h", async fx => {
      await fx.check(79, NOW - HOUR); await fx.check(80); await fx.check(85, NOW + 6 * HOUR - 1_000);
      await fx.check(86, NOW + 6 * HOUR); return fx;
    }],
    then: ["two warnings, each with the plan and the confirm command", fx => {
      expect(percents(fx)).toEqual([["80"], ["86"]]);
      expect(fx.notify.mock.calls[0][0]).toContain("Claude panes are at 80%. `/byt 2@example.test` shows the plan to");
      expect(fx.notify.mock.calls[0][0]).toContain("`/byt 2@example.test ok` moves only the panes the plan approves");
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
      expect(fx.notify.mock.calls[0][0]).toMatch(/\*\*Codex 1\*\* · 1@example\.test · \*\*82%\*\* used · resets/u);
      expect(fx.notify.mock.calls[0][0]).toContain("**test:0** is at 82%. Write `//switch 2` in test:0 to move only test:0");
    }],
  });

  unit("without an account below 80 % there is no action but both accounts remain visible", {
    given: ["an account a pane runs on", () => fixture()],
    when: ["the only other account is at 80 %", fx => fx.check(85, NOW, { spare: 80 }).then(() => fx)],
    then: ["no switch is suggested", fx => {
      const lines = fx.notify.mock.calls[0][0].split("\n");
      expect(lines).toHaveLength(5);
      expect(lines[0]).toBe("**Weekly quota** · no action needed");
      expect(lines[1]).toContain("**Claude 1** · 1@example.test · **85%** used");
      expect(lines[2]).toBe("↳ test:0");
      expect(lines[3]).toContain("**Claude 2** · 2@example.test · **80%** used");
      expect(lines[4]).toBe("↳ no panes");
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
      const [action, ...accounts] = fx.notify.mock.calls[0][0].split("\n");
      expect(action).toMatch(/^\*\*Weekly quota\*\* · \*\*skybar:4\*\*.*`\/\/switch 2`/u);
      expect(accounts).toHaveLength(6);
      expect(accounts[0]).toMatch(/^⚠️ \*\*Claude 1\*\* · a@example\.test · \*\*84%/u);
      expect(accounts[2]).toMatch(/^🔴 \*\*Codex 1\*\* · b@example\.test · \*\*100%/u);
    }],
  });
});
