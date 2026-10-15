import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feature, unit, expect } from "bdd-vitest";
import { vi } from "vitest";
import { createSentNoticeStore, parseQuotaWarningConfig, runQuotaWarningTick, weeklyWindowKey } from "./quota-warning.mjs";

const NOW = Date.parse("2026-10-15T11:00:00Z");
const RESET = "2026-10-16T11:00:00Z";
const source = { email: "active@example.test", profile: { id: "active" } };
const target = { email: "spare@example.test", profile: { id: "spare" } };
const weekly = (usedPercent, resetsAt = RESET) => ({ ok: true, limits: [{ kind: "weekly_all", usedPercent, resetsAt }] });

function fixture({ actor = "api:0", spare = 17, previous = [], reserve = 90 } = {}) {
  const path = join(mkdtempSync(join(tmpdir(), "quota-reserve-")), "sent.json");
  const store = createSentNoticeStore(path);
  store.record(weeklyWindowKey(source.email, RESET), previous, { now: NOW, resetAt: Date.parse(RESET) });
  const notify = vi.fn(async () => ({ sent: true }));
  const deliverActor = vi.fn(async () => ({ queued: true }));
  const run = (resetsAt = RESET) => runQuotaWarningTick({
    accountsInUse: () => [source], allAccounts: () => [source, target],
    readQuota: async (profile) => weekly(profile.id === "active" ? 91 : spare, resetsAt),
    historyOf: () => [{ at: NOW - 10 * 3_600_000, usedPercent: 90, resetsAt },
      { at: NOW, usedPercent: 91, resetsAt }],
    notify, deliverActor, sent: createSentNoticeStore(path), now: NOW,
    config: parseQuotaWarningConfig({ AMUX_QUOTA_WARN_ACTOR: actor, AMUX_QUOTA_RESERVE_PERCENT: String(reserve) }),
  });
  return { run, notify, deliverActor };
}

feature("weekly quota reserve", () => {
  unit("91 percent warns both recipients even when the pace lasts until reset", {
    given: ["a slow active account with spare capacity and an actor", () => fixture()],
    when: ["the warning runs", async (fx) => ({ ...fx, notices: await fx.run() })],
    then: ["the reserve command reaches the human and the actor", (fx) => {
      expect(fx.notices.map(n => n.level)).toEqual(["reserve"]);
      const text = fx.notify.mock.calls[0][0];
      expect(text).not.toContain("ingen åtgärd");
      expect(text).toContain("amux accounts rotate claude:spare@example.test");
      expect(fx.deliverActor).toHaveBeenCalledWith("api:0", text, expect.objectContaining({
        idempotencyKey: expect.stringContaining(":reserve:actor:api:0"),
      }));
    }],
  });

  unit("threshold and urgent cannot suppress reserve", {
    given: ["both older levels recorded", () => fixture({ previous: ["threshold", "urgent"] })],
    when: ["the warning runs", async (fx) => ({ ...fx, notices: await fx.run() })],
    then: ["reserve is delivered once to each recipient", (fx) => {
      expect(fx.notices.map(n => n.level)).toEqual(["reserve"]);
      expect(fx.notify).toHaveBeenCalledTimes(1);
      expect(fx.deliverActor).toHaveBeenCalledTimes(1);
    }],
  });

  unit("a fresh sent-store preserves deduplication but allows the next weekly window", {
    given: ["an actor and a persistent sent-store", () => fixture()],
    when: ["three new store instances read two windows", async (fx) => {
      await fx.run(); await fx.run(); await fx.run("2026-10-23T11:00:00Z"); return fx;
    }],
    then: ["each recipient gets one reserve per window", (fx) => {
      expect(fx.notify).toHaveBeenCalledTimes(2);
      expect(fx.deliverActor).toHaveBeenCalledTimes(2);
      expect(fx.notify.mock.calls.every(([text]) => text.includes("reservgränsen"))).toBe(true);
    }],
  });

  unit("no alternative below reserve warns only the human without an action line", {
    given: ["the only other account is at the reserve boundary", () => fixture({ spare: 90 })],
    when: ["the warning runs", async (fx) => { await fx.run(); return fx; }],
    then: ["the actor stays asleep and the shortage is explicit", (fx) => {
      expect(fx.notify).toHaveBeenCalledTimes(1);
      expect(fx.notify.mock.calls[0][0]).toMatch(/Inget annat Claude-konto.*under.*90 %/u);
      expect(fx.notify.mock.calls[0][0]).not.toMatch(/rotate|Åtgärd:|ingen åtgärd/u);
      expect(fx.deliverActor).not.toHaveBeenCalled();
    }],
  });

  unit("no configured actor keeps the warning human-only", {
    given: ["spare capacity without an actor", () => fixture({ actor: "" })],
    when: ["the warning runs", async (fx) => { await fx.run(); return fx; }],
    then: ["only the human receives the reserve command", (fx) => {
      expect(fx.notify.mock.calls[0][0]).toContain("amux accounts rotate claude:spare@example.test");
      expect(fx.deliverActor).not.toHaveBeenCalled();
    }],
  });

  unit("the reserve threshold is configurable", {
    given: ["reserve set to 92 above current usage", () => fixture({ reserve: 92 })],
    when: ["the warning runs", async (fx) => ({ ...fx, notices: await fx.run() })],
    then: ["the ordinary slow-pace warning does not wake the actor", (fx) => {
      expect(fx.notices[0].level).toBe("threshold");
      expect(fx.deliverActor).not.toHaveBeenCalled();
    }],
  });

  unit("a failed actor enqueue is retried with the same durable identities", {
    given: ["a previously warned human and a failed actor enqueue", () => {
      const fx = fixture(); fx.deliverActor.mockRejectedValueOnce(new Error("queue unavailable")); return fx;
    }],
    when: ["the tick fails and a fresh store retries", async (fx) => {
      await expect(fx.run()).rejects.toThrow("queue unavailable"); await fx.run(); await fx.run(); return fx;
    }],
    then: ["the completed notice stops retries and both identities stay stable", (fx) => {
      expect(fx.notify).toHaveBeenCalledTimes(2);
      expect(fx.notify.mock.calls[0][1].idempotencyKey).toBe(fx.notify.mock.calls[1][1].idempotencyKey);
      expect(fx.deliverActor).toHaveBeenCalledTimes(2);
      expect(fx.deliverActor.mock.calls[0][2]).toEqual(fx.deliverActor.mock.calls[1][2]);
    }],
  });
});
