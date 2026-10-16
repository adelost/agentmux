import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
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
const percents = fx => fx.notify.mock.calls.map(([text]) => [...text.matchAll(/(?:Claude|Codex) 1 1@example\.test: (\d+) % av veckan/gu)].map(m => m[1]));

const today = () => ({ accounts: [
  account("codex", "1", 47, ["lsrc:8", "lsrc:3"], "adelost@gmail.com"),
  account("codex", "2", 100, ["skybar:4"], "mattias.wetterlind@gmail.com"),
  account("claude", "1", 85, ["skybar:2", "claw:2"], "adelost@gmail.com"),
  account("claude", "wetterlind", 97, [], "mattias.wetterlind@gmail.com"),
  { ok: false, provider: "claude", profile: { id: "2" }, account: { email: "attrois@gmail.com" }, error: "login_expired", inUse: [] },
  { ok: false, provider: "kimi", profile: { id: "1", label: "mattias.wetterlind@gmail.com" }, error: "credentials_expired", inUse: [] },
] });

feature("complete quota warning, Mattias 2026-10-16", () => {
  unit("a logged-in Kimi account keeps its known weekly reading", {
    when: ["formatting the provider's normalized weekly window", () => formatQuotaWarning({ accounts: [{ ok: true,
      provider: "kimi", profile: { id: "1" }, account: { email: "a@example.test" }, inUse: [],
      limits: [{ kind: "weekly", usedPercent: 21, resetsAt: RESET }],
    }] }, { now: NOW })],
    then: ["the account row shows the reading rather than inventing an unknown quota", text =>
      expect(text).toMatch(/Kimi 1 a@example\.test: 21 % av veckan, reset .*; ingen panel\./u)],
  });
  unit("today's warning names one pane-local action, every account and unused or logged-out logins", {
    when: ["formatting today's account and pane readings", () => formatQuotaWarning(today(), { now: NOW })],
    then: ["the action is first, followed only by one line per account and one logged-out line", text => {
      const lines = text.split("\n");
      expect(lines).toHaveLength(6);
      expect(lines[0]).toMatch(/^skybar:4.*`\/\/switch 1`.*bara skybar:4.*Codex 1 adelost@gmail\.com \(47 %\)/u);
      expect(lines[0]).toContain("Övriga paneler behåller sina konton");
      expect(lines[0]).toContain("olika konton samtidigt");
      expect(lines[1]).toMatch(/^Codex 1 adelost@gmail\.com: 47 % av veckan, reset .*; paneler lsrc:3,8\.$/u);
      expect(lines[2]).toMatch(/^Codex 2 mattias\.wetterlind@gmail\.com: 100 % av veckan, reset .*; paneler skybar:4\.$/u);
      expect(lines[3]).toMatch(/^Claude 1 adelost@gmail\.com: 85 % av veckan, reset .*; paneler claw:2, skybar:2\.$/u);
      expect(lines[4]).toMatch(/^Claude wetterlind mattias\.wetterlind@gmail\.com: 97 % av veckan, reset .*; ingen panel\.$/u);
      expect(lines[5]).toBe("Utloggade: Claude attrois@gmail.com · Kimi mattias.wetterlind@gmail.com");
    }],
  });
  for (const [name, changes] of [
    ["below the warning threshold", snapshot => { snapshot.accounts[1].limits[0].windows[0].usedPercent = 79; }],
    ["no pane on the full account", snapshot => { snapshot.accounts[1].inUse = []; }],
    ["no spare account of the same provider", snapshot => { snapshot.accounts[0].limits[0].windows[0].usedPercent = 80; }],
  ]) unit(`no action when ${name}`, {
    given: [name, () => { const snapshot = today(); changes(snapshot); return snapshot; }],
    when: ["formatting the warning", snapshot => formatQuotaWarning(snapshot, { now: NOW })],
    then: ["the complete account view starts with no action", text => expect(text.split("\n")[0]).toBe("Ingen åtgärd.")],
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
      expect(fx.notify.mock.calls[0][0]).toContain("`/byt 2@example.test` visar planen för test:0");
      expect(fx.notify.mock.calls[0][0]).toContain("`/byt 2@example.test ok` flyttar dessa paneler när de är lediga");
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
      expect(fx.notify.mock.calls[0][0]).toMatch(/Codex 1 1@example\.test: 82 % av veckan, reset/u);
      expect(fx.notify.mock.calls[0][0]).toContain("`//switch 2` i test:0 flyttar bara test:0");
    }],
  });

  unit("without an account below 80 % there is no action but both accounts remain visible", {
    given: ["an account a pane runs on", () => fixture()],
    when: ["the only other account is at 80 %", fx => fx.check(85, NOW, { spare: 80 }).then(() => fx)],
    then: ["no switch is suggested", fx => {
      const lines = fx.notify.mock.calls[0][0].split("\n");
      expect(lines).toHaveLength(3);
      expect(lines[0]).toBe("Ingen åtgärd.");
      expect(lines[1]).toMatch(/^Claude 1 1@example\.test: 85 %.*paneler test:0\.$/u);
      expect(lines[2]).toMatch(/^Claude 2 2@example\.test: 80 %.*ingen panel\.$/u);
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
      expect(action).toMatch(/^skybar:4.*`\/\/switch 2`/u);
      expect(accounts).toHaveLength(3);
      expect(accounts[0]).toMatch(/^Claude 1 a@example\.test: 84 %/u);
      expect(accounts[1]).toMatch(/^Codex 1 b@example\.test: 100 %/u);
    }],
  });
});
