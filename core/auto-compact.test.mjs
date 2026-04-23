import { unit, feature, expect } from "bdd-vitest";
import {
  decideAutoCompactAction,
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
    given: ["70% idle", () => ({ ...base, contextPercent: 70 })],
    when: ["deciding", (args) => decideAutoCompactAction(args)],
    then: ["action=warn", (r) => expect(r.action).toBe("warn")],
  });

  unit("1% below threshold → none", {
    given: ["69% idle", () => ({ ...base, contextPercent: 69 })],
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
    given: ["warning + context=60%", () => {
      const warnings = new Map([[key, { warned_at: base.now - 20_000 }]]);
      return { ...base, warnings, contextPercent: 60 };
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
