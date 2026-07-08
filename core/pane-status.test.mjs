// The traits table replaced ten scattered hardcoded status lists (icons,
// done-buckets, compact-safety, live-checks, sort tiers). These tests pin
// the trait semantics each consumer now relies on — a wrong row here
// silently rewires done/ps/auto-compact all at once.

import { feature, unit, expect } from "bdd-vitest";
import {
  PANE_STATUS,
  statusIcon,
  isLiveStatus,
  needsHumanStatus,
  statusTier,
  isCompactUnsafe,
} from "./pane-status.mjs";

feature("pane status traits table", () => {
  unit("every status row is complete", {
    given: ["the table", () => Object.entries(PANE_STATUS)],
    when: ["checking each row", (rows) => rows.map(([name, t]) => ({
      name,
      ok: typeof t.icon === "string" && typeof t.live === "boolean"
        && typeof t.needsHuman === "boolean" && typeof t.compactUnsafe === "boolean"
        && Number.isInteger(t.tier),
    }))],
    then: ["all rows carry all five traits", (results) => {
      for (const r of results) expect(r.ok, r.name).toBe(true);
    }],
  });

  unit("trait semantics match consumer expectations", {
    given: ["the trait helpers", () => null],
    when: ["querying the load-bearing statuses", () => ({
      live: ["working", "resume"].map(isLiveStatus),
      notLive: ["interrupted", "permission", "idle"].map(isLiveStatus),
      needsHuman: ["permission", "menu", "interrupted", "limited"].map(needsHumanStatus),
      humanFree: ["working", "idle", "dismiss"].map(needsHumanStatus),
      compactUnsafe: ["working", "permission", "menu", "interrupted", "limited"].map(isCompactUnsafe),
      compactable: ["idle", "unknown", "resume", "dismiss"].map(isCompactUnsafe),
    })],
    then: ["live/needsHuman/compactUnsafe partition as the callers assume", (r) => {
      expect(r.live).toEqual([true, true]);
      expect(r.notLive).toEqual([false, false, false]);
      expect(r.needsHuman).toEqual([true, true, true, true]);
      expect(r.humanFree).toEqual([false, false, false]);
      expect(r.compactUnsafe).toEqual([true, true, true, true, true]);
      expect(r.compactable).toEqual([false, false, false, false]);
    }],
  });

  unit("an unknown status string degrades safely", {
    given: ["a status the table has never heard of", () => "limited-someday"],
    when: ["querying every helper", (s) => ({
      icon: statusIcon(s),
      live: isLiveStatus(s),
      needsHuman: needsHumanStatus(s),
      tier: statusTier(s),
      compactUnsafe: isCompactUnsafe(s),
    })],
    then: ["⚪, not live, tier 0 — and NOT safe to compact (safe direction)", (r) => {
      expect(r).toEqual({ icon: "⚪", live: false, needsHuman: false, tier: 0, compactUnsafe: true });
    }],
  });
});
