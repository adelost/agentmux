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
    then: ["enabled=true, threshold=40, pollMs=60000", (result) => {
      expect(result.enabled).toBe(true);
      expect(result.turnThreshold).toBe(40);
      expect(result.pollMs).toBe(60_000);
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

  unit("forwardReply defaults true", {
    given: ["empty env", () => ({ env: {} })],
    when: ["parsing", ({ env }) => parseReminderConfig(env)],
    then: ["forwardReply=true", (result) => expect(result.forwardReply).toBe(true)],
  });

  unit("FORWARD_REPLY=false disables forwarder", {
    given: ["forward off", () => ({ env: { AMUX_REMIND_FORWARD_REPLY: "false" } })],
    when: ["parsing", ({ env }) => parseReminderConfig(env)],
    then: ["forwardReply=false", (result) => expect(result.forwardReply).toBe(false)],
  });

  unit("replyTimeoutMs defaults to 60s", {
    given: ["empty env", () => ({ env: {} })],
    when: ["parsing", ({ env }) => parseReminderConfig(env)],
    then: ["replyTimeoutMs=60000", (result) => expect(result.replyTimeoutMs).toBe(60_000)],
  });

  unit("too-low reply timeout clamped to default", {
    given: ["1s timeout (too short)", () => ({ env: { AMUX_REMIND_REPLY_TIMEOUT_MS: "1000" } })],
    when: ["parsing", ({ env }) => parseReminderConfig(env)],
    then: ["replyTimeoutMs=60000 (default)", (result) => expect(result.replyTimeoutMs).toBe(60_000)],
  });
});

feature("decideReminderAction", () => {
  const base = { turnThreshold: 40 };

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
