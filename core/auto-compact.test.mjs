import { unit, feature, expect } from "bdd-vitest";
import {
  decideAutoCompactAction,
  resolveActivityMs,
  parseAutoCompactConfig,
  formatWarningMessage,
  formatCompactedMessage,
  DEFAULT_CONFIG,
} from "./auto-compact.mjs";

const cfg = (overrides = {}) => ({ ...DEFAULT_CONFIG, ...overrides });
const key = "claw:3";
const base = {
  paneKey: key,
  status: "idle",
  contextPercent: 80,
  paneInMode: "0",
  warnings: new Map(),
  config: cfg(),
  now: 1_700_000_000_000,
  lastActivityMs: 1_700_000_000_000 - 10 * 60_000,
};

feature("decideAutoCompactAction — disabled config", () => {
  unit("returns action:none when enabled=false", {
    given: ["auto-compact disabled", () => ({ ...base, config: cfg({ enabled: false }) })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=none, reason=disabled", (r) => {
      expect(r.action).toBe("none");
      expect(r.reason).toBe("disabled");
    }],
  });
});

feature("decideAutoCompactAction — first crossing (warn)", () => {
  unit("idle pane over threshold with no prior warning → warn", {
    given: ["80% idle, no warning", () => base],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=warn", (r) => expect(r.action).toBe("warn")],
  });

  unit("exactly at threshold → warn", {
    given: ["60% idle", () => ({ ...base, contextPercent: 60 })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=warn", (r) => expect(r.action).toBe("warn")],
  });

  unit("1% below threshold → none", {
    given: ["59% idle", () => ({ ...base, contextPercent: 59 })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=none", (r) => expect(r.action).toBe("none")],
  });
});

feature("decideAutoCompactAction — grace period (no fire)", () => {
  unit("warning exists but grace not elapsed → none", {
    given: ["warned 10s ago, grace 60s", () => {
      const warnings = new Map([[key, { warned_at: base.now - 10_000 }]]);
      return { ...base, warnings };
    }],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=none, reason has remaining seconds", (r) => {
      expect(r.action).toBe("none");
      expect(r.reason).toMatch(/50s remaining/);
    }],
  });

  unit("warning exists + grace exactly elapsed → compact", {
    given: ["warned 60s ago, grace 60s", () => {
      const warnings = new Map([[key, { warned_at: base.now - 60_000 }]]);
      return { ...base, warnings };
    }],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=compact", (r) => expect(r.action).toBe("compact")],
  });

  unit("warning exists + grace exceeded → compact", {
    given: ["warned 2 min ago, grace 60s", () => {
      const warnings = new Map([[key, { warned_at: base.now - 120_000 }]]);
      return { ...base, warnings };
    }],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=compact", (r) => expect(r.action).toBe("compact")],
  });
});

feature("decideAutoCompactAction — activity cancels warning", () => {
  unit("pane went from idle to working during grace → cancel warning", {
    given: ["warning exists, now status=working", () => {
      const warnings = new Map([[key, { warned_at: base.now - 30_000 }]]);
      return { ...base, warnings, status: "working" };
    }],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=cancel, reason=pane active", (r) => {
      expect(r.action).toBe("cancel");
      expect(r.reason).toBe("pane active");
    }],
  });

  unit("resume status also counts as active → cancel", {
    given: ["warning + status=resume", () => {
      const warnings = new Map([[key, { warned_at: base.now - 5_000 }]]);
      return { ...base, warnings, status: "resume" };
    }],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=cancel", (r) => expect(r.action).toBe("cancel")],
  });

  unit("pane entered copy-mode during grace → cancel", {
    given: ["warning + pane_in_mode=1", () => {
      const warnings = new Map([[key, { warned_at: base.now - 20_000 }]]);
      return { ...base, warnings, paneInMode: "1" };
    }],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=cancel, reason=in copy-mode", (r) => {
      expect(r.action).toBe("cancel");
      expect(r.reason).toBe("in copy-mode");
    }],
  });

  unit("context dropped below threshold during grace → cancel", {
    given: ["warning + context=59%", () => {
      const warnings = new Map([[key, { warned_at: base.now - 20_000 }]]);
      return { ...base, warnings, contextPercent: 59 };
    }],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=cancel", (r) => expect(r.action).toBe("cancel")],
  });
});

feature("decideAutoCompactAction — working panes never warned", () => {
  unit("active pane at 90% with no existing warning → none", {
    given: ["working pane, no warning", () => ({ ...base, status: "working", contextPercent: 90 })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=none", (r) => expect(r.action).toBe("none")],
  });

  unit("in copy-mode + no warning → none", {
    given: ["idle but in copy-mode, no warning", () => ({ ...base, paneInMode: "1" })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=none", (r) => expect(r.action).toBe("none")],
  });
});

feature("decideAutoCompactAction — min-idle gate (conversation freshness)", () => {
  unit("recent turn (30s ago) blocks warning at 80% idle", {
    given: ["idle 80% but last turn 30s ago, min-idle=5min", () => ({
      ...base,
      lastActivityMs: base.now - 30_000,
    })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=none, reason explains need for silence", (r) => {
      expect(r.action).toBe("none");
      expect(r.reason).toMatch(/recent turn 30s ago/);
    }],
  });

  unit("turn exactly at min-idle threshold passes gate → warn", {
    given: ["last turn exactly 5min ago", () => ({
      ...base,
      lastActivityMs: base.now - 300_000,
    })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=warn", (r) => expect(r.action).toBe("warn")],
  });

  unit("turn 10min ago passes gate → warn", {
    given: ["last turn 10 min ago", () => ({
      ...base,
      lastActivityMs: base.now - 600_000,
    })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=warn", (r) => expect(r.action).toBe("warn")],
  });

  unit("null lastActivityMs fails closed because freshness is unknown", {
    given: ["no jsonl data", () => ({ ...base, lastActivityMs: null })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=none with a classified reason", (r) => {
      expect(r).toEqual({ action: "none", reason: "conversation activity unknown" });
    }],
  });

  unit("fresh turn cancels existing warning", {
    given: ["pending warning but recent turn", () => {
      const warnings = new Map([[key, { warned_at: base.now - 30_000 }]]);
      return { ...base, warnings, lastActivityMs: base.now - 5_000 };
    }],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=cancel, reason=recent activity", (r) => {
      expect(r.action).toBe("cancel");
      expect(r.reason).toMatch(/recent activity/);
    }],
  });
});

feature("decideAutoCompactAction — verify-before-refire (no-op /compact)", () => {
  unit("fired at 100%, context still 100% → suppress, do not re-fire", {
    given: ["compactFloor=100, context still 100% (the observed runaway)", () => ({
      ...base,
      contextPercent: 100,
      compactFloors: new Map([[key, 100]]),
    })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=suppress", (r) => {
      expect(r.action).toBe("suppress");
      expect(r.reason).toMatch(/ineffective/);
    }],
  });

  unit("fired at 81%, context climbed to 100% (working pane) → still suppress", {
    given: ["compactFloor=81, context now 100%", () => ({
      ...base,
      contextPercent: 100,
      compactFloors: new Map([[key, 81]]),
    })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=suppress (≥ floor)", (r) => expect(r.action).toBe("suppress")],
  });

  unit("compact worked: context dropped below floor but still over threshold → resume (warn)", {
    given: ["compactFloor=100, context now 80% (>threshold)", () => ({
      ...base,
      contextPercent: 80,
      compactFloors: new Map([[key, 100]]),
    })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=warn (floor no longer blocks; will re-record lower on fire)", (r) => expect(r.action).toBe("warn")],
  });

  unit("compact worked: context fell below threshold → cancel (clears floor)", {
    given: ["compactFloor=100, context now 30%", () => ({
      ...base,
      contextPercent: 30,
      compactFloors: new Map([[key, 100]]),
    })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=cancel", (r) => {
      expect(r.action).toBe("cancel");
      expect(r.reason).toBe("below threshold");
    }],
  });

  unit("pane went active with a floor on file → cancel (resets suppression)", {
    given: ["compactFloor=100, status now working", () => ({
      ...base,
      status: "working",
      contextPercent: 100,
      compactFloors: new Map([[key, 100]]),
    })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=cancel, reason=pane active", (r) => {
      expect(r.action).toBe("cancel");
      expect(r.reason).toBe("pane active");
    }],
  });

  unit("no floor on file → normal warn (regression: default empty Map)", {
    given: ["100% idle, no compactFloors passed at all", () => ({
      ...base,
      contextPercent: 100,
    })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=warn", (r) => expect(r.action).toBe("warn")],
  });
});

feature("resolveActivityMs — turn timestamp is the activity signal, not file mtime", () => {
  // The recurring auto-compact warning flood: a fresh file mtime (the jsonl was
  // touched for a non-turn record) posed as activity and cancelled the pending
  // warning every poll. The activity signal must be the real turn timestamp.
  const now = 1_700_000_000_000;

  unit("fresh mtime must NOT override an older real turn (the bug)", {
    given: ["newest turn 1h ago, file touched 37s ago", () => ({
      turnMs: now - 3_600_000,
      fileMtimeMs: now - 37_000,
    })],
    when: ["resolving", (args) => resolveActivityMs(args)],
    then: ["returns the TURN ts (1h ago), not the mtime", (r) => {
      expect(r).toBe(now - 3_600_000);
    }],
  });

  unit("turn ts is used even when mtime is older too", {
    given: ["turn 2min ago, mtime 5min ago", () => ({
      turnMs: now - 120_000,
      fileMtimeMs: now - 300_000,
    })],
    when: ["resolving", (args) => resolveActivityMs(args)],
    then: ["returns turn ts", (r) => expect(r).toBe(now - 120_000)],
  });

  unit("no readable turn → fall back to file mtime (fresh session proxy)", {
    given: ["no turn, mtime 10s ago", () => ({ turnMs: NaN, fileMtimeMs: now - 10_000 })],
    when: ["resolving", (args) => resolveActivityMs(args)],
    then: ["returns mtime", (r) => expect(r).toBe(now - 10_000)],
  });

  unit("neither turn nor mtime → null (skips the gate)", {
    given: ["nothing readable", () => ({ turnMs: NaN, fileMtimeMs: NaN })],
    when: ["resolving", (args) => resolveActivityMs(args)],
    then: ["returns null", (r) => expect(r).toBe(null)],
  });

  unit("no args at all → null (defensive)", {
    given: ["called with nothing", () => undefined],
    when: ["resolving", () => resolveActivityMs()],
    then: ["returns null", (r) => expect(r).toBe(null)],
  });
});

feature("resolveActivityMs — partial tail must not fabricate freshness (the 8th-time hole)", () => {
  // claw:1 2026-07-02: a 201MB session's newest turn sat >64KB from EOF, so the
  // 64KB tail parsed ZERO turns. That is NOT a fresh session — but the old code
  // treated "no turn" as one and fell back to the (constantly touched) mtime,
  // so the genuinely-idle pane read as active and the warning was cancelled
  // every poll. Selection bias: high-context panes have giant turns, so the
  // fallback broke on exactly the population auto-compact targets.
  const now = 1_700_000_000_000;

  unit("no turn in a PARTIAL tail + fresh mtime → null, not mtime (the bug)", {
    given: ["turns empty, mtime 10s ago, file NOT fully read", () => ({
      turnMs: NaN,
      fileMtimeMs: now - 10_000,
      fileFullyRead: false,
    })],
    when: ["resolving", (args) => resolveActivityMs(args)],
    then: ["returns null — unknown, min-idle gate skipped, grace still protects", (r) => {
      expect(r).toBe(null);
    }],
  });

  unit("no turn in a FULLY-read file + fresh mtime → mtime (fresh-session proxy stays)", {
    given: ["turns empty, mtime 10s ago, whole file parsed", () => ({
      turnMs: NaN,
      fileMtimeMs: now - 10_000,
      fileFullyRead: true,
    })],
    when: ["resolving", (args) => resolveActivityMs(args)],
    then: ["returns mtime", (r) => expect(r).toBe(now - 10_000)],
  });

  unit("real turn wins regardless of fileFullyRead", {
    given: ["turn 1h ago found in partial tail", () => ({
      turnMs: now - 3_600_000,
      fileMtimeMs: now - 10_000,
      fileFullyRead: false,
    })],
    when: ["resolving", (args) => resolveActivityMs(args)],
    then: ["returns turn ts", (r) => expect(r).toBe(now - 3_600_000)],
  });
});

feature("regression: an unreadable giant-turn pane fails closed", () => {
  // A bounded reader may still meet a record larger than its entire safety
  // window. Unknown cannot prove idle, so an old warning is cancelled rather
  // than compacting active context or re-warning forever.
  const now = 1_700_000_000_000;
  const cfgIdle = cfg();

  unit("an aged warning is cancelled when no real activity clock is readable", {
    given: ["77% idle, warned 60s ago, no turn readable, mtime 8s old, partial tail", () => {
      const lastActivityMs = resolveActivityMs({ turnMs: NaN, fileMtimeMs: now - 8_000, fileFullyRead: false });
      const warnings = new Map([[key, { warned_at: now - 60_000 }]]);
      return { ...base, contextPercent: 77, warnings, lastActivityMs, config: cfgIdle, now };
    }],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=cancel with the classified reason", (r) => {
      expect(r).toEqual({ action: "cancel", reason: "conversation activity unknown" });
    }],
  });
});

feature("regression: idle pane with mtime noise matures to compact (not endless re-warn)", () => {
  // End-to-end of the observed ai:2 flood: a 93% idle pane whose jsonl mtime is
  // 37s old but whose newest real turn is 1h old. With the activity signal fixed
  // to the turn ts, the min-idle gate passes, so a pending warning that has sat
  // out the grace window FIRES /compact instead of being cancelled by phantom
  // "recent activity".
  const now = 1_700_000_000_000;
  const cfgIdle = cfg();

  unit("warn matures to compact: turn 1h old beats fresh 37s mtime", {
    given: ["93% idle, warned 60s ago, turn 1h old, mtime 37s old", () => {
      const lastActivityMs = resolveActivityMs({ turnMs: now - 3_600_000, fileMtimeMs: now - 37_000 });
      const warnings = new Map([[key, { warned_at: now - 60_000 }]]);
      return { ...base, contextPercent: 93, warnings, lastActivityMs, config: cfgIdle, now };
    }],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=compact (NOT cancel)", (r) => expect(r.action).toBe("compact")],
  });

  unit("first crossing warns instead of being cancelled by mtime noise", {
    given: ["93% idle, no warning, turn 1h old, mtime 37s old", () => {
      const lastActivityMs = resolveActivityMs({ turnMs: now - 3_600_000, fileMtimeMs: now - 37_000 });
      return { ...base, contextPercent: 93, lastActivityMs, config: cfgIdle, now };
    }],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=warn", (r) => expect(r.action).toBe("warn")],
  });
});

feature("parseAutoCompactConfig — minIdleMs", () => {
  unit("minIdleMs from env AUTO_COMPACT_MIN_IDLE_MS", {
    given: ["env override", () => ({ env: { AUTO_COMPACT_MIN_IDLE_MS: "120000" } })],
    when: ["parsing", ({ env }) => parseAutoCompactConfig(env)],
    then: ["parsed to 2 min", (r) => expect(r.minIdleMs).toBe(120_000)],
  });

  unit("minIdleMs defaults to 5 min when unset", {
    given: ["no env", () => ({ env: {} })],
    when: ["parsing", ({ env }) => parseAutoCompactConfig(env)],
    then: ["default 300_000 ms", (r) => expect(r.minIdleMs).toBe(300_000)],
  });
});

feature("decideAutoCompactAction — missing context data", () => {
  unit("null contextPercent → none", {
    given: ["no context readable", () => ({ ...base, contextPercent: null })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=none, reason=no context data", (r) => {
      expect(r.action).toBe("none");
      expect(r.reason).toBe("no context data");
    }],
  });

  unit("NaN contextPercent → none", {
    given: ["NaN context", () => ({ ...base, contextPercent: NaN })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=none", (r) => expect(r.action).toBe("none")],
  });
});

feature("parseAutoCompactConfig", () => {
  unit("defaults when env empty", {
    given: ["no env vars", () => ({ env: {} })],
    when: ["parsing", ({ env }) => parseAutoCompactConfig(env)],
    then: ["matches DEFAULT_CONFIG", (r) => {
      expect(r.enabled).toBe(true);
      expect(r.codexEnabled).toBe(true);
      expect(r.threshold).toBe(60);
      expect(r.threshold).toBe(DEFAULT_CONFIG.threshold);
      expect(r.graceMs).toBe(DEFAULT_CONFIG.graceMs);
      expect(r.pollMs).toBe(DEFAULT_CONFIG.pollMs);
    }],
  });

  unit("AUTO_COMPACT_ENABLED=false disables", {
    given: ["env with disable", () => ({ env: { AUTO_COMPACT_ENABLED: "false" } })],
    when: ["parsing", ({ env }) => parseAutoCompactConfig(env)],
    then: ["enabled=false", (r) => expect(r.enabled).toBe(false)],
  });

  unit("AUTO_COMPACT_CODEX=false explicitly disables Codex compaction", {
    given: ["env with the Codex opt-out", () => ({ env: { AUTO_COMPACT_CODEX: "false" } })],
    when: ["parsing", ({ env }) => parseAutoCompactConfig(env)],
    then: ["codexEnabled=false", (r) => expect(r.codexEnabled).toBe(false)],
  });

  unit("custom threshold + grace from env", {
    given: ["env overrides", () => ({
      env: { AUTO_COMPACT_WARN_THRESHOLD: "80", AUTO_COMPACT_GRACE_MS: "120000" },
    })],
    when: ["parsing", ({ env }) => parseAutoCompactConfig(env)],
    then: ["values applied", (r) => {
      expect(r.threshold).toBe(80);
      expect(r.graceMs).toBe(120_000);
    }],
  });
});

feature("format helpers", () => {
  unit("warning message includes pane, percent, seconds", {
    given: ["args", () => ({ key: "claw:3", pct: 78, grace: 60_000 })],
    when: ["formatting", ({ key, pct, grace }) => formatWarningMessage(key, pct, grace)],
    then: ["contains all fields", (r) => {
      expect(r).toMatch(/claw:3/);
      expect(r).toMatch(/78%/);
      expect(r).toMatch(/60s/);
      expect(r).toMatch(/cancel/i);
    }],
  });

  unit("compacted message names pane + pre-compact percent", {
    given: ["args", () => ({ key: "claw:3", pct: 78 })],
    when: ["formatting", ({ key, pct }) => formatCompactedMessage(key, pct)],
    then: ["contains both", (r) => {
      expect(r).toMatch(/claw:3/);
      expect(r).toMatch(/78%/);
    }],
  });
});

// --- Do-not-touch statuses ---------------------------------------------
// /compact must never be aimed at a pane where it would misfire or is
// futile: modals eat it, an interrupted turn needs a human decision, and a
// rate-limited pane can't run compaction at all (ai:1 2026-07-08 got a
// false "100% and idle" warning while merely rate-limited).

feature("decideAutoCompactAction — do-not-touch statuses", () => {
  unit("a rate-limited pane over threshold is left alone", {
    given: ["limited pane at 100%", () =>
      ({ ...base, status: "limited", contextPercent: 100 })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=none — no warning, no fire", (r) => {
      expect(r.action).toBe("none");
    }],
  });

  unit("a pending warning is cancelled when the pane turns limited", {
    given: ["limited pane with a warning on file", () => ({
      ...base,
      status: "limited",
      contextPercent: 100,
      warnings: new Map([[key, { warned_at: base.now - 30_000 }]]),
    })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=cancel with an explanatory reason", (r) => {
      expect(r.action).toBe("cancel");
      expect(r.reason).toContain("limited");
    }],
  });

  unit("an interrupted pane over threshold is left alone", {
    given: ["interrupted codex-style pane at 90%", () =>
      ({ ...base, status: "interrupted", contextPercent: 90 })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=none", (r) => expect(r.action).toBe("none")],
  });

  unit("a permission modal over threshold is left alone", {
    given: ["permission pane at 85%", () =>
      ({ ...base, status: "permission", contextPercent: 85 })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=none — a /compact would be eaten by the modal", (r) =>
      expect(r.action).toBe("none")],
  });
});
