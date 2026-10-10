import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { claudeAccountsOf, createSentNoticeStore, parseQuotaWarningConfig, runQuotaWarningTick } from "./quota-warning.mjs";

const HOUR = 3_600_000;
const NOW = Date.parse("2026-10-10T08:30:00Z");
const RESET = "2026-10-14T07:00:00Z";
const profile = (id) => ({ provider: "claude", id, key: `claude:${id}` });
const EMAILS = { 1: "adelost@gmail.com", wetterlind: "mattias.wetterlind@gmail.com", 2: "attrois@gmail.com" };
const identityOf = (candidate) => ({ email: EMAILS[candidate.id] });
const weekly = (usedPercent) => ({ ok: true, limits: [{ kind: "weekly_all", usedPercent, resetsAt: RESET }] });

function fixture({ used = { wetterlind: 82, 1: 26 }, history = [] } = {}) {
  const notify = vi.fn(async () => ({ sent: true }));
  const readQuota = vi.fn(async (candidate) => candidate.id === "2"
    ? { ok: false, error: "login_expired" } : weekly(used[candidate.id]));
  const sent = createSentNoticeStore(join(mkdtempSync(join(tmpdir(), "amux-quota-warning-")), "sent.json"));
  const tick = (now = NOW) => runQuotaWarningTick({
    accountsInUse: () => claudeAccountsOf([profile("wetterlind"), profile("wetterlind")], identityOf),
    allAccounts: () => claudeAccountsOf([profile("1"), profile("2"), profile("wetterlind")], identityOf),
    readQuota, historyOf: () => history, notify, sent, now,
    config: { ...parseQuotaWarningConfig({}), warnPercent: 80, urgentHours: 12 },
  });
  return { notify, readQuota, tick };
}

feature("weekly Claude quota warning", () => {
  unit("one notice per account and window, however often the tick runs", {
    given: ["wetterlind past 80 % with a pace that lasts", () => fixture({
      history: [{ at: NOW - 10 * HOUR, usedPercent: 81, resetsAt: RESET }, { at: NOW, usedPercent: 82, resetsAt: RESET }] })],
    when: ["three ticks run", async (fx) => { for (let i = 0; i < 3; i++) await fx.tick(NOW + i * 15 * 60_000); return fx; }],
    then: ["exactly one notice went out, saying no action", (fx) => {
      expect(fx.notify).toHaveBeenCalledTimes(1);
      expect(fx.notify.mock.calls[0][0]).toMatch(/: ingen åtgärd\./u);
      expect(fx.notify.mock.calls[0][1]).toMatchObject({ level: "warn", title: "Claude-kvot" });
    }],
  });

  unit("an urgent notice is sent once and is never followed by the weaker one", {
    given: ["a store shared by successive ticks", () => {
      const store = createSentNoticeStore(join(mkdtempSync(join(tmpdir(), "amux-quota-warning-")), "sent.json"));
      const notify = vi.fn(async () => ({ sent: true }));
      const run = (usedPercent, history, now) => runQuotaWarningTick({
        accountsInUse: () => claudeAccountsOf([profile("wetterlind")], identityOf),
        allAccounts: () => claudeAccountsOf([profile("1"), profile("2"), profile("wetterlind")], identityOf),
        readQuota: async (candidate) => candidate.id === "2" ? { ok: false, error: "login_expired" }
          : weekly(candidate.id === "1" ? 26 : usedPercent),
        historyOf: () => history, notify, sent: store, now,
        config: { ...parseQuotaWarningConfig({}), warnPercent: 80, urgentHours: 12 },
      });
      return { run, notify };
    }],
    when: ["a slow 82 %, then a fast 95 %, then the fast pace again", async ({ run, notify }) => {
      await run(82, [{ at: NOW - 10 * HOUR, usedPercent: 81, resetsAt: RESET }, { at: NOW, usedPercent: 82, resetsAt: RESET }], NOW);
      const fast = [{ at: NOW - HOUR, usedPercent: 82, resetsAt: RESET }, { at: NOW + HOUR, usedPercent: 95, resetsAt: RESET }];
      await run(95, fast, NOW + HOUR);
      await run(95, fast, NOW + HOUR + 15 * 60_000);
      return notify;
    }],
    then: ["two notices: the ordinary, then one urgent naming adelost as the target, never attrois", (notify) => {
      expect(notify.mock.calls.map(([, options]) => options.level)).toEqual(["warn", "urgent"]);
      expect(notify.mock.calls[1][0]).toMatch(/tar slut om ca \d+ h/u);
      expect(notify.mock.calls[1][0]).toMatch(/rotate claude:adelost@gmail\.com --dry/u);
      expect(notify.mock.calls.map(([text]) => text).join("\n")).not.toMatch(/attrois/u);
    }],
  });

  unit("an account no pane runs on is never warned about", {
    given: ["adelost far past the threshold but no pane on it", () => fixture({ used: { wetterlind: 20, 1: 99 } })],
    when: ["a tick runs", async (fx) => { await fx.tick(); return fx; }],
    then: ["nothing is sent", (fx) => {
      expect(fx.notify).not.toHaveBeenCalled();
    }],
  });

  unit("two panes on one account read its usage once", {
    given: ["both panes on wetterlind", () => fixture({ used: { wetterlind: 20, 1: 26 } })],
    when: ["a tick runs", async (fx) => { await fx.tick(); return fx; }],
    then: ["one usage read, no notice under the threshold", (fx) => {
      expect(fx.readQuota).toHaveBeenCalledTimes(1);
      expect(fx.notify).not.toHaveBeenCalled();
    }],
  });
});
