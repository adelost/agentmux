import { feature, unit, expect } from "bdd-vitest";
import { formatQuotaSnapshot } from "./quota-format.mjs";
import { buildQuotaOverview } from "../channels/quota-overview.mjs";
import { accountEntries } from "./quota-profiles.mjs";

const NOW = Date.parse("2026-10-24T06:06:00Z");
const account = subscription => ({ ok: true, provider: "claude", name: "Claude W",
  profile: { id: "wetterlind" }, account: { email: "wetterlind@example.test", plan: "max" }, inUse: [],
  limits: [{ kind: "weekly_all", usedPercent: 99, resetsAt: "2026-10-28T07:00:00Z" }], subscription });
const render = subscription => {
  const snapshot = { generatedAt: new Date(NOW).toISOString(), accounts: [account(subscription)] };
  return [formatQuotaSnapshot(snapshot, { now: NOW }), buildQuotaOverview(snapshot, { now: NOW, config: { warnPercent: 80 } }).text];
};

feature("manual quota facts cannot masquerade as current provider readings", () => {
  unit("both quota surfaces mark facts older than 24 hours stale", {
    when: ["the last reset reading was yesterday", () => render({ freeResetsLeft: 2,
      freeResetsReadOn: "2026-10-23", freeResetsReadAt: "2026-10-23T06:05:59Z" })],
    then: ["the count carries its age and warning", texts => texts.forEach(text => {
      expect(text).toMatch(/STALE/u); expect(text).toMatch(/age 24h/u); expect(text).toContain("2026-10-23");
    })],
  });
  unit("a renewal day in the past is invalid even if read just now", {
    when: ["an old renewal survived in the profile", () => render({ renewsOn: "2026-10-20", renewsReadAt: "2026-10-24T06:06:00Z" })],
    then: ["neither surface presents it as an upcoming renewal", texts => texts.forEach(text => expect(text).toContain("INVALID: renewal date has passed"))],
  });
  unit("fresh plan tiers show their reading time and age", {
    when: ["Max 20x was read six minutes ago", () => render({ planTier: "Max (20x)", planReadAt: "2026-10-24T06:00:00Z" })],
    then: ["both surfaces distinguish the manual tier", texts => texts.forEach(text => {
      expect(text).toContain("Max (20x)"); expect(text).toContain("age 6m"); expect(text).not.toContain("STALE");
    })],
  });
  unit("unknown reading age is stale and exactly 24 hours is still dated", {
    when: ["rendering legacy undated renewals and the exact age boundary", () => [render({ renewsOn: "2026-11-12" }),
      render({ planTier: "Max (20x)", planReadAt: "2026-10-23T06:06:00Z" })]],
    then: ["unknown never looks live; only over 24 hours is stale", ([unknown, boundary]) => {
      unknown.forEach(text => expect(text).toContain("age unknown"));
      boundary.forEach(text => { expect(text).toContain("age 24h"); expect(text).not.toContain("STALE"); });
    }],
  });
  unit("the actual profile reader retains dated manual facts", {
    when: ["reading an operator profile", () => accountEntries({ HOME: "/test" }, { readFile: () => JSON.stringify({ version: 2,
      accounts: { "claude:wetterlind": { subscription: { planTier: "Max (20x)", planReadAt: "2026-10-24T06:00:00Z",
        autoReload: false, autoReloadReadAt: "2026-10-24T06:00:00Z" } } } }) })],
    then: ["metadata survives rather than silently disappearing", result => {
      expect(result.problems).toEqual([]);
      expect(result.entries.get("claude:wetterlind").subscription).toMatchObject({ planTier: "Max (20x)", autoReload: false });
    }],
  });
});
