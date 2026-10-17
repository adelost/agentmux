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
import { createQuotaWarningOnWrite, readWarningSnapshot, readWarningActivity, createQuotaLimitPoll } from "./quota-warning-runtime.mjs";

const due = { accounts: [{ ok: true, provider: "claude", profile: { id: "1" }, account: { email: "a@example.test" },
  inUse: ["lsrc:0"], activeInUse: ["lsrc:0"], limits: [{ kind: "weekly_all", usedPercent: 85, resetsAt: new Date(Date.now() + 86_400_000).toISOString() }] }] };
const message = () => ({ send: vi.fn(async () => ({})) });
function hook(readSnapshot = async () => due, env = {}) {
  const sent = createSentNoticeStore(join(mkdtempSync(join(tmpdir(), "quota-hook-")), "sent.json"));
  const log = vi.fn();
  return { log, warn: createQuotaWarningOnWrite({ env, sent, readSnapshot, observe: () => {}, log }) };
}

feature("the quota warning answers the human message", () => {
  unit("the snapshot reads through the shared quota budget, not a cold cache", {
    when: ["reading the warning snapshot", () => readWarningSnapshot()],
    then: ["every provider is included in the complete account warning", () => {
      expect(readQuotaSnapshot).toHaveBeenCalledWith({ profiles: [{ provider: "claude" }, { provider: "codex" }, { provider: "kimi" }] });
    }],
  });

  unit("two quick messages get one warning, in the channel written in", {
    given: ["a due account", () => ({ ...hook(), first: message(), second: message() })],
    when: ["two messages arrive together", async fx => { await Promise.all([fx.warn(fx.first), fx.warn(fx.second)]); return fx; }],
    then: ["only the first channel gets the notice", fx => {
      expect(fx.first.send).toHaveBeenCalledTimes(1);
      expect(fx.first.send.mock.calls[0]).toEqual([expect.stringMatching(/^⚠️ Claude a: 85 %, slut ca .*1 aktiv panel\.$/u), { kind: "notice" }]);
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

feature("warning activity and background reached-limit routing", () => {
  unit("working or last-hour work qualifies, an old idle panel does not", {
    when: ["reading canonical statuses and conversation times", async () => {
      const now = Date.now();
      const snapshot = { accounts: [{ ...due.accounts[0], inUse: ["test:0", "test:1", "test:2", "test:3"] }] };
      return readWarningActivity(snapshot, { now, agents: [{ name: "test", dir: "/test" }],
        statusFor: async (_name, pane) => pane === 0 ? "working" : "idle",
        activityFor: (_dir, _engine, pane) => pane === 1 ? now - 3_600_000 : pane === 2 ? now - 3_600_001 : null,
      });
    }],
    then: ["only working and the inclusive one-hour boundary count", snapshot =>
      expect(snapshot.accounts[0].activeInUse).toEqual(["test:0", "test:1"])],
  });
  unit("the installed snapshot path applies activity after actual account ownership", {
    when: ["a pane is idle despite a live process on the account", () => readWarningSnapshot({
      readSnapshot: async () => ({ accounts: [{ ...due.accounts[0], activeInUse: undefined }] }),
      readActivity: async snapshot => ({ ...snapshot, accounts: snapshot.accounts.map(account => ({ ...account, activeInUse: [] })) }),
    })],
    then: ["it cannot qualify as active", snapshot => expect(snapshot.accounts[0].activeInUse).toEqual([])],
  });
  unit("the background pulse posts a full account without any human write", {
    when: ["a 95 percent reminder precedes the reached-limit pulse", async () => {
      let usedPercent = 95;
      const fx = hook(async () => ({ accounts: [{ ...due.accounts[0], limits: [
        { ...due.accounts[0].limits[0], usedPercent },
      ] }] }));
      await fx.warn(message()); usedPercent = 100;
      const send = vi.fn(async () => {});
      const poll = createQuotaLimitPoll({ check: fx.warn, channels: [{ send }],
        channelMap: () => new Map([["own-channel", { name: "lsrc", pane: 0 }]]) });
      await poll(); await poll(); return send;
    }],
    then: ["the full alert reaches an affected pane's channel once", send => {
      expect(send).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[0]).toEqual(["own-channel", expect.stringContaining("100 %, kvoten är slut"), { kind: "notice" }]);
    }],
  });
  unit("a missing channel cannot mark the reached-limit alert as delivered", {
    when: ["the first pulse lacks a route and a later pulse has one", async () => {
      const fx = hook(async () => ({ accounts: [{ ...due.accounts[0], limits: [{ ...due.accounts[0].limits[0], usedPercent: 100 }] }] }));
      let mapped = false; const send = vi.fn(async () => {});
      const poll = createQuotaLimitPoll({ check: fx.warn, channels: [{ send }],
        channelMap: () => mapped ? new Map([["own-channel", { name: "lsrc", pane: 0 }]]) : new Map() });
      await poll(); mapped = true; await poll(); return send;
    }],
    then: ["the later valid route still receives the alert", send => expect(send).toHaveBeenCalledTimes(1)],
  });
});

feature("quota rows are edited, Sky 2026-10-17", () => {
  unit("usage edits the row and a newly reached limit posts a visible alert", {
    when: ["one human notice is followed by changed usage and a full-limit pulse", async () => {
      let usedPercent = 85;
      const fx = hook(async () => ({ accounts: [{ ...due.accounts[0], limits: [{ ...due.accounts[0].limits[0], usedPercent }] }] }));
      const send = vi.fn(async () => ({ id: "notice-1", channelId: "human-channel" })), editNotice = vi.fn(async () => {});
      const msg = { channelId: "human-channel", send };
      await fx.warn(msg, { editNotice }); usedPercent = 86; await fx.warn(msg, { editNotice });
      usedPercent = 100;
      const poll = createQuotaLimitPoll({ check: fx.warn, channels: [{ send, editMessage: (channelId, messageId, text) => editNotice({ channelId, messageId }, text) }],
        channelMap: () => new Map([["human-channel", { name: "lsrc", pane: 0 }]]) });
      await poll(); await poll(); return { send, editNotice };
    }],
    then: ["one ordinary edit and one new full-limit signal", ({ send, editNotice }) => {
      expect(send).toHaveBeenCalledTimes(2); expect(editNotice).toHaveBeenCalledTimes(1);
      expect(send.mock.calls[1][1]).toContain("100 %, kvoten är slut");
    }],
  });
});

feature("an explicitly deleted quota row", () => {
  unit("forgets a missing row and still posts a newly reached limit", {
    when: ["an edit gets Discord unknown-message before the account fills", async () => {
      let usedPercent = 85;
      const fx = hook(async () => ({ accounts: [{ ...due.accounts[0], limits: [{ ...due.accounts[0].limits[0], usedPercent }] }] }));
      const send = vi.fn(async () => ({ id: "row", channelId: "channel" }));
      const editNotice = vi.fn(async () => { throw Object.assign(Error("deleted"), { code: 10008 }); });
      const msg = { channelId: "channel", send };
      await fx.warn(msg, { editNotice }); usedPercent = 86;
      await fx.warn(msg, { editNotice }); await fx.warn(msg, { editNotice });
      usedPercent = 100; await fx.warn(msg, { editNotice }); return { send, editNotice };
    }],
    then: ["one missing edit, two creates including the full-limit alert", ({ send, editNotice }) => {
      expect(editNotice).toHaveBeenCalledTimes(1); expect(send).toHaveBeenCalledTimes(2);
      expect(send.mock.calls[1][0]).toContain("100 %, kvoten är slut");
    }],
  });
});

feature("the account row keeps its current forecast", () => {
  unit("a changed forecast edits the row even when percentage and active count stay the same", {
    when: ["the same quota reading is revisited an hour later", async () => {
      const { postDueQuotaWarnings } = await import("./quota-warning.mjs");
      const sent = createSentNoticeStore(join(mkdtempSync(join(tmpdir(), "quota-forecast-edit-")), "sent.json"));
      const snapshot = { accounts: [{ ...due.accounts[0], limits: [{ kind: "weekly_all", usedPercent: 85, resetsAt: "2026-10-22T06:13:00Z" }] }] };
      const notify = vi.fn(async () => ({ channelId: "human", messageId: "notice-1" })), editNotice = vi.fn(async () => {});
      const now = Date.parse("2026-10-17T09:00:00Z");
      await postDueQuotaWarnings({ snapshot, sent, notify, editNotice, now });
      await postDueQuotaWarnings({ snapshot, sent, notify, editNotice, now: now + 3_600_000 });
      return { notify, editNotice };
    }],
    then: ["one post remains and its forecast is updated", ({ notify, editNotice }) => {
      expect(notify).toHaveBeenCalledTimes(1);
      expect(editNotice).toHaveBeenCalledTimes(1);
      expect(editNotice.mock.calls[0][1]).not.toBe(notify.mock.calls[0][0]);
    }],
  });
});


feature("stable usage does not churn the forecast row", () => {
  unit("120 half-minute pulses produce only one hourly forecast edit", {
    when: ["usage and active panes stay constant for an hour and the human returns after seven hours", async () => {
      const { postDueQuotaWarnings } = await import("./quota-warning.mjs");
      const sent = createSentNoticeStore(join(mkdtempSync(join(tmpdir(), "quota-steady-")), "sent.json"));
      const snapshot = { accounts: [{ ...due.accounts[0], limits: [{ kind: "weekly_all", usedPercent: 85, resetsAt: "2026-10-22T06:13:00Z" }] }] };
      const notify = vi.fn(async () => ({ channelId: "human", messageId: "notice-1" })), editNotice = vi.fn(async () => {});
      const now = Date.parse("2026-10-17T09:00:00Z"), hour = 3_600_000;
      await postDueQuotaWarnings({ snapshot, sent, notify, editNotice, now });
      for (let t = 30_000; t <= hour; t += 30_000) await postDueQuotaWarnings({ snapshot, sent, notify, editNotice, now: now + t, fullOnly: true });
      const hourlyEdits = editNotice.mock.calls.length;
      await postDueQuotaWarnings({ snapshot, sent, notify, editNotice, now: now + 7 * hour });
      return { notify, editNotice, hourlyEdits };
    }],
    then: ["one create, one edit in the first hour and an edit rather than a seven-hour repost", ({ notify, editNotice, hourlyEdits }) => {
      expect(hourlyEdits).toBe(1); expect(notify).toHaveBeenCalledTimes(1); expect(editNotice).toHaveBeenCalledTimes(2);
    }],
  });
});
