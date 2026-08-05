// Contracts for the shared quota text render: every surface (Discord, CLI)
// shows the same truth, failures are named loudly, and thresholds mark rows.

import { feature, unit, expect } from "bdd-vitest";
import { formatQuotaSnapshot, formatReset } from "./quota-format.mjs";

// Mirrors the readQuotaSnapshot() shape captured live 2026-07-15.
const SNAPSHOT = {
  generatedAt: "2026-07-15T15:00:20.486Z",
  claude: {
    ok: true,
    engine: "claude",
    limits: [
      { id: "session", kind: "session", scopeName: null, usedPercent: 9, resetsAt: "2026-07-15T19:20:00+00:00" },
      { id: "weekly_all", kind: "weekly_all", scopeName: null, usedPercent: 13, resetsAt: "2026-07-22T06:59:59+00:00" },
      { id: "weekly_fable", kind: "weekly_scoped", scopeName: "Fable", usedPercent: 16, resetsAt: "2026-07-22T06:59:59+00:00" },
    ],
  },
  codex: {
    ok: true,
    engine: "codex",
    limits: [{
      capturedAt: "2026-07-15T14:43:11.083Z",
      limitId: "codex",
      planType: "pro",
      windows: [{ id: "primary", usedPercent: 70, windowMinutes: 10_080, resetsAt: "2026-07-21T22:17:27.000Z" }],
    }],
  },
};

const withClaudePercents = (session, weekly, fable) => ({
  ...SNAPSHOT,
  claude: {
    ...SNAPSHOT.claude,
    limits: [
      { ...SNAPSHOT.claude.limits[0], usedPercent: session },
      { ...SNAPSHOT.claude.limits[1], usedPercent: weekly },
      { ...SNAPSHOT.claude.limits[2], usedPercent: fable },
    ],
  },
});

feature("quota text render for bridge and CLI", () => {
  unit("shows every Claude limit and the Codex week on their own engine lines", {
    when: ["rendering a live-shaped snapshot", () => formatQuotaSnapshot(SNAPSHOT).split("\n")],
    then: ["Claude carries session/week/Fable and Codex carries its week", ([, claude, codex]) => {
      expect(claude).toContain("session 9%");
      expect(claude).toContain("vecka 13%");
      expect(claude).toContain("vecka Fable 16%");
      expect(codex).toContain("vecka 70%");
    }],
  });

  unit("session carries its own reset; the weekly rows share one suffix", {
    when: ["rendering the Claude line", () => formatQuotaSnapshot(SNAPSHOT).split("\n")[1]],
    then: ["two reset stamps appear: the session's own and the shared weekly one", (claude) => {
      expect(claude).toContain("session 9% (reset 15 jul");
      expect(claude).toContain("(reset 22 jul");
    }],
  });

  unit("marks 70%+ with a warning and 90%+ as critical", {
    when: ["rendering elevated percentages", () => formatQuotaSnapshot(withClaudePercents(9, 71, 93))],
    then: ["rows at the thresholds are marked, calm rows are not", (text) => {
      expect(text).toContain("vecka 71% ⚠️");
      expect(text).toContain("vecka Fable 93% 🔴");
      expect(text).not.toContain("session 9% ⚠️");
    }],
  });

  unit("a failed Claude read is named loudly while Codex still renders", {
    when: ["rendering with a typed Claude error", () =>
      formatQuotaSnapshot({ ...SNAPSHOT, claude: { ok: false, error: "credentials_expired" } })],
    then: ["the error is named, the healthy engine is unaffected", (text) => {
      expect(text).toContain("Claude  otillgänglig (credentials_expired)");
      expect(text).toContain("vecka 70%");
    }],
  });

  unit("a failed Codex read is named loudly while Claude still renders", {
    when: ["rendering with a typed Codex error", () =>
      formatQuotaSnapshot({ ...SNAPSHOT, codex: { ok: false, error: "no_session_files" } })],
    then: ["the error is named, the healthy engine is unaffected", (text) => {
      expect(text).toContain("Codex   otillgänglig (no_session_files)");
      expect(text).toContain("vecka Fable 16%");
    }],
  });

  unit("an unparseable reset timestamp renders no suffix instead of NaN", {
    when: ["formatting invalid inputs", () => [formatReset("not-a-date"), formatReset(null)]],
    then: ["both collapse to empty string", (results) => {
      expect(results).toEqual(["", ""]);
    }],
  });

  unit("marks duplicate profile identities and keeps Kimi compact", {
    when: ["rendering two Kimi profiles logged into the same account", () => formatQuotaSnapshot({
      accounts: ["1", "2"].map((id) => ({
        ok: true, provider: "kimi", profile: { id, key: `kimi:${id}` },
        account: { identityKey: "same-account", plan: "Allegretto" },
        limits: [
          { id: "weekly", scopeName: "Vecka", usedPercent: 100, resetsAt: null },
          { id: "rolling", scopeName: "5 h", usedPercent: 20, resetsAt: null },
        ],
      })),
    })],
    then: ["every window is shown — the window KIND decides what a stop means", (text) => {
      // "· 2 gränser" hid the fact that settles a diagnosis: a 5h window heals
      // itself, the weekly does not. 2026-08-05 three panes were misread as
      // month-dead while the hidden 5h row was the actual bound.
      expect(text.match(/⚠ samma inloggning/gu)).toHaveLength(2);
      expect(text).toContain("Vecka 100% 🔴");
      expect(text).toContain("5 h 20%");
      expect(text).not.toContain("gränser");
    }],
  });
});
