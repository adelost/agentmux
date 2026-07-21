import { unit, feature, expect } from "bdd-vitest";
import { unlinkSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  loadReminderState,
  saveReminderState,
  parseReminderConfig,
  decideReminderAction,
  cutoffFor,
  formatReminderMessage,
  recordReminderDelivery,
  DRIFT_SECTIONS,
} from "./reminder-state.mjs";

const tmpPath = () =>
  join(tmpdir(), `amux-reminder-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
const cleanup = (p) => { try { unlinkSync(p); } catch {} };

feature("loadReminderState / saveReminderState", () => {
  unit("loadReminderState returns {} when file missing", {
    given: ["fresh path", () => ({ path: tmpPath() })],
    when: ["loading", ({ path }) => loadReminderState(path)],
    then: ["empty object", (result) => expect(result).toEqual({})],
  });

  unit("save+load roundtrip preserves per-pane entries", {
    given: ["a path and a state map", () => ({
      path: tmpPath(),
      state: {
        "claw:0": { lastReminderTsMs: 1_700_000_000_000, lastCompactTsMs: null },
        "ai:2":   { lastReminderTsMs: null, lastCompactTsMs: 1_700_000_500_000 },
      },
    })],
    when: ["save then load", ({ path, state }) => {
      saveReminderState(state, path);
      const loaded = loadReminderState(path);
      cleanup(path);
      return loaded;
    }],
    then: ["deep-equal to saved", (result) => {
      expect(result["claw:0"].lastReminderTsMs).toBe(1_700_000_000_000);
      expect(result["ai:2"].lastCompactTsMs).toBe(1_700_000_500_000);
    }],
  });

  unit("loadReminderState returns {} for malformed json", {
    given: ["a path with garbage", () => {
      const path = tmpPath();
      const { writeFileSync } = require("fs");
      writeFileSync(path, "}{not json");
      return { path };
    }],
    when: ["loading", ({ path }) => loadReminderState(path)],
    then: ["empty object (safe fallback)", (result, { path }) => {
      cleanup(path);
      expect(result).toEqual({});
    }],
  });
});

feature("parseReminderConfig", () => {
  unit("defaults when env is empty", {
    given: ["empty env", () => ({ env: {} })],
    when: ["parsing", ({ env }) => parseReminderConfig(env)],
    then: ["enabled=true, threshold=40, pollMs=60000, activeWindowMs=1h", (result) => {
      expect(result.enabled).toBe(true);
      expect(result.turnThreshold).toBe(40);
      expect(result.pollMs).toBe(60_000);
      expect(result.activeWindowMs).toBe(3_600_000);
    }],
  });

  unit("ENABLED=false disables", {
    given: ["disabled env", () => ({ env: { AMUX_REMIND_ENABLED: "false" } })],
    when: ["parsing", ({ env }) => parseReminderConfig(env)],
    then: ["enabled=false", (result) => expect(result.enabled).toBe(false)],
  });

  unit("TURN_THRESHOLD override", {
    given: ["custom threshold", () => ({ env: { AMUX_REMIND_TURN_THRESHOLD: "60" } })],
    when: ["parsing", ({ env }) => parseReminderConfig(env)],
    then: ["threshold=60", (result) => expect(result.turnThreshold).toBe(60)],
  });

  unit("invalid threshold falls back to default", {
    given: ["negative threshold", () => ({ env: { AMUX_REMIND_TURN_THRESHOLD: "-5" } })],
    when: ["parsing", ({ env }) => parseReminderConfig(env)],
    then: ["threshold=40 (default)", (result) => expect(result.turnThreshold).toBe(40)],
  });

  unit("too-low poll interval clamped to default", {
    given: ["1s poll (too aggressive)", () => ({ env: { AMUX_REMIND_POLL_MS: "1000" } })],
    when: ["parsing", ({ env }) => parseReminderConfig(env)],
    then: ["pollMs=60000 (default)", (result) => expect(result.pollMs).toBe(60_000)],
  });

});

feature("decideReminderAction", () => {
  const base = {
    turnThreshold: 40,
    latestWorkTsMs: 9_000,
    nowMs: 10_000,
    activeWindowMs: 60_000,
    runtimeState: { running: true, shell: false, dead: false },
  };

  unit("no send when below threshold", {
    given: ["30 turns", () => ({ turnsSinceCutoff: 30, status: "idle", ...base })],
    when: ["deciding", (args) => decideReminderAction(args)],
    then: ["none", (r) => expect(r.action).toBe("none")],
  });

  unit("send when above threshold and idle", {
    given: ["50 turns", () => ({ turnsSinceCutoff: 50, status: "idle", ...base })],
    when: ["deciding", (args) => decideReminderAction(args)],
    then: ["send", (r) => expect(r.action).toBe("send")],
  });

  unit("send when exactly at threshold", {
    given: ["40 turns exact", () => ({ turnsSinceCutoff: 40, status: "idle", ...base })],
    when: ["deciding", (args) => decideReminderAction(args)],
    then: ["send", (r) => expect(r.action).toBe("send")],
  });

  unit("no send when working (never interrupt)", {
    given: ["above threshold but working", () => ({ turnsSinceCutoff: 100, status: "working", ...base })],
    when: ["deciding", (args) => decideReminderAction(args)],
    then: ["none", (r) => {
      expect(r.action).toBe("none");
      expect(r.reason).toMatch(/working/);
    }],
  });

  unit("no send when permission modal open", {
    given: ["permission pane", () => ({ turnsSinceCutoff: 100, status: "permission", ...base })],
    when: ["deciding", (args) => decideReminderAction(args)],
    then: ["none", (r) => expect(r.action).toBe("none")],
  });

  unit("no send when menu modal open", {
    given: ["menu pane", () => ({ turnsSinceCutoff: 100, status: "menu", ...base })],
    when: ["deciding", (args) => decideReminderAction(args)],
    then: ["none", (r) => expect(r.action).toBe("none")],
  });

  unit("no send when status unknown (conservative)", {
    given: ["unknown pane", () => ({ turnsSinceCutoff: 100, status: "unknown", ...base })],
    when: ["deciding", (args) => decideReminderAction(args)],
    then: ["none", (r) => expect(r.action).toBe("none")],
  });

  unit("no send for invalid turn count", {
    given: ["NaN turns", () => ({ turnsSinceCutoff: NaN, status: "idle", ...base })],
    when: ["deciding", (args) => decideReminderAction(args)],
    then: ["none", (r) => expect(r.action).toBe("none")],
  });

  unit("no send for negative turn count", {
    given: ["-1 turns (impossible but defensive)", () => ({ turnsSinceCutoff: -1, status: "idle", ...base })],
    when: ["deciding", (args) => decideReminderAction(args)],
    then: ["none", (r) => expect(r.action).toBe("none")],
  });

  unit("no send when work is stale even if the historical turn count is high", {
    given: ["an idle pane last used two hours ago", () => ({
      turnsSinceCutoff: 100, status: "idle", ...base,
      latestWorkTsMs: 1_000, nowMs: 7_201_000, activeWindowMs: 3_600_000,
    })],
    when: ["deciding", (args) => decideReminderAction(args)],
    then: ["none with an honest reason", (r) => expect(r).toEqual({ action: "none", reason: "work activity is stale" })],
  });

  unit("no send when the coding process is sleeping", {
    given: ["recent work but a shell-only pane", () => ({
      turnsSinceCutoff: 100, status: "idle", ...base,
      runtimeState: { running: false, shell: true, dead: false },
    })],
    when: ["deciding", (args) => decideReminderAction(args)],
    then: ["none without waking", (r) => expect(r).toEqual({ action: "none", reason: "pane is sleeping or unavailable" })],
  });
});

feature("cutoffFor", () => {
  unit("null when no state", {
    given: ["null state", () => ({ state: null })],
    when: ["computing", ({ state }) => cutoffFor(state)],
    then: ["null", (r) => expect(r).toBeNull()],
  });

  unit("null when both ts missing", {
    given: ["empty state", () => ({ state: {} })],
    when: ["computing", ({ state }) => cutoffFor(state)],
    then: ["null", (r) => expect(r).toBeNull()],
  });

  unit("returns reminder ts when only reminder set", {
    given: ["only reminder", () => ({ state: { lastReminderTsMs: 1000 } })],
    when: ["computing", ({ state }) => cutoffFor(state)],
    then: ["reminder ts", (r) => expect(r).toBe(1000)],
  });

  unit("returns compact ts when only compact set", {
    given: ["only compact", () => ({ state: { lastCompactTsMs: 2000 } })],
    when: ["computing", ({ state }) => cutoffFor(state)],
    then: ["compact ts", (r) => expect(r).toBe(2000)],
  });

  unit("returns max when both set", {
    given: ["both set, compact newer", () => ({
      state: { lastReminderTsMs: 1000, lastCompactTsMs: 3000 },
    })],
    when: ["computing", ({ state }) => cutoffFor(state)],
    then: ["3000 (compact)", (r) => expect(r).toBe(3000)],
  });

  unit("returns max when reminder is newer", {
    given: ["reminder newer", () => ({
      state: { lastReminderTsMs: 5000, lastCompactTsMs: 2000 },
    })],
    when: ["computing", ({ state }) => cutoffFor(state)],
    then: ["5000 (reminder)", (r) => expect(r).toBe(5000)],
  });
});

feature("recordReminderDelivery", () => {
  unit("failed delivery leaves timestamp and rotation untouched", {
    given: ["an existing pane state", () => ({
      paneState: { lastReminderTsMs: 100, reminderCount: 2 },
    })],
    when: ["recording a failed send", ({ paneState }) => ({
      changed: recordReminderDelivery(paneState, { delivered: false, nowMs: 200, reminderCount: 2 }),
      paneState,
    })],
    then: ["state is unchanged so the next tick retries", ({ changed, paneState }) => {
      expect(changed).toBe(false);
      expect(paneState).toEqual({ lastReminderTsMs: 100, reminderCount: 2 });
    }],
  });

  unit("successful delivery advances timestamp and rotation once", {
    given: ["a pane state", () => ({ paneState: { lastReminderTsMs: null, reminderCount: 0 } })],
    when: ["recording success", ({ paneState }) => ({
      changed: recordReminderDelivery(paneState, { delivered: true, nowMs: 200, reminderCount: 0 }),
      paneState,
    })],
    then: ["state advances", ({ changed, paneState }) => {
      expect(changed).toBe(true);
      expect(paneState).toMatchObject({ lastReminderTsMs: 200, reminderCount: 1 });
    }],
  });
});

feature("formatReminderMessage", () => {
  unit("includes turn count", {
    given: ["45 turns", () => ({ n: 45 })],
    when: ["formatting", ({ n }) => formatReminderMessage(n)],
    then: ["string mentions 45 and CLAUDE.md", (r) => {
      expect(r).toMatch(/45/);
      expect(r).toMatch(/CLAUDE\.md/);
    }],
  });

  unit("starts with [drift-guard] marker", {
    given: ["any count", () => ({ n: 100 })],
    when: ["formatting", ({ n }) => formatReminderMessage(n)],
    then: ["has prefix", (r) => expect(r.startsWith("[drift-guard]")).toBe(true)],
  });

  unit("requires a one-sentence summary reply (1.16.10 behavior)", {
    given: ["any count", () => ({ n: 50 })],
    when: ["formatting", ({ n }) => formatReminderMessage(n)],
    then: ["asks for ONE sentence summary so the rule lands as latest assistant text", (r) => {
      expect(r).toMatch(/ONE sentence/);
      expect(r).toMatch(/summarizing/i);
      expect(r).not.toMatch(/silently/i);
      expect(r).not.toMatch(/no reply needed/i);
    }],
  });
});

feature("formatReminderMessage rotation (1.20.69 behavior)", () => {
  unit("first reminder targets Kommunikationsdisciplin (highest-priority rule at index 0)", {
    given: ["reminderCount 0", () => ({ n: 45, count: 0 })],
    when: ["formatting", ({ n, count }) => formatReminderMessage(n, count)],
    then: ["names the comms rule and its core directive", (r) => {
      expect(r).toMatch(/Kommunikationsdisciplin/);
      expect(r).toMatch(/commits \+ ledger ARE the status/);
    }],
  });

  unit("omitted reminderCount defaults to index 0 (legacy call sites keep working)", {
    given: ["no count argument", () => ({ n: 50 })],
    when: ["formatting", ({ n }) => formatReminderMessage(n)],
    then: ["identical to explicit count 0", (r) =>
      expect(r).toBe(formatReminderMessage(50, 0))],
  });

  unit("count advances through the section list", {
    given: ["counts 1..3", () => ({ n: 45 })],
    when: ["formatting each", ({ n }) => [1, 2, 3].map((c) => formatReminderMessage(n, c))],
    then: ["coding-philosophy, recommendation, root-cause in order", ([r1, r2, r3]) => {
      expect(r1).toMatch(/coding-philosophy\.md/);
      expect(r2).toMatch(/Always lead with a recommendation/);
      expect(r3).toMatch(/Root cause > symptoms/);
    }],
  });

  unit("count wraps around past the list end", {
    given: ["count equal to list length", () => ({ n: 45, count: DRIFT_SECTIONS.length })],
    when: ["formatting", ({ n, count }) => formatReminderMessage(n, count)],
    then: ["same message as count 0", (r) => expect(r).toBe(formatReminderMessage(45, 0))],
  });

  unit("whole-file entries (section: null) point at the file without a section clause", {
    given: ["the coding-philosophy slot", () => ({ n: 45, count: 1 })],
    when: ["formatting", ({ n, count }) => formatReminderMessage(n, count)],
    then: ["re-read targets the file itself", (r) => {
      expect(r).toMatch(/Re-read ~\/\.claude\/coding-philosophy\.md:/);
      expect(r).not.toMatch(/section of ~\/\.claude\/coding-philosophy\.md/);
    }],
  });

  unit("every rotation entry keeps the message invariants", {
    given: ["all section indices", () => ({ indices: DRIFT_SECTIONS.map((_, i) => i) })],
    when: ["formatting each", ({ indices }) => indices.map((i) => ({
      rule: DRIFT_SECTIONS[i],
      msg: formatReminderMessage(40, i),
    }))],
    then: ["prefix, one-sentence demand, turn count, own file named", (results) => {
      for (const { rule, msg } of results) {
        expect(msg.startsWith("[drift-guard]")).toBe(true);
        expect(msg).toMatch(/ONE sentence/);
        expect(msg).toMatch(/40/);
        expect(msg).toContain(rule.file);
        expect(msg).not.toMatch(/silently/i);
      }
    }],
  });
});

feature("formatReminderMessage mention-all (1.20.90 behavior)", () => {
  unit("every reminder mentions ALL drift rules, regardless of rotation slot", {
    given: ["all rotation indices", () => ({ indices: DRIFT_SECTIONS.map((_, i) => i) })],
    when: ["formatting each", ({ indices }) => indices.map((i) => formatReminderMessage(40, i))],
    then: ["each message carries 'Also still in force' + alla fyra reglernas nyckelord", (msgs) => {
      for (const msg of msgs) {
        expect(msg).toMatch(/Also still in force/);
        expect(msg).toMatch(/kommunikationsdisciplin|Kommunikationsdisciplin/);
        expect(msg).toMatch(/coding-philosophy\.md/);
        expect(msg).toMatch(/lead with a recommendation|Always lead with a recommendation/i);
        expect(msg).toMatch(/root cause > symptoms/i);
      }
    }],
  });

  unit("only the highlighted rule carries the summary demand (no four-sentence recital)", {
    given: ["slot 0", () => ({})],
    when: ["formatting", () => formatReminderMessage(40, 0)],
    then: ["ONE summary, om den markerade regeln", (msg) => {
      expect(msg).toMatch(/ONE sentence summarizing the highlighted rule/);
      expect((msg.match(/Reply with/g) || []).length).toBe(1);
    }],
  });
});
