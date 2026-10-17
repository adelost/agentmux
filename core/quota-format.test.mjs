// Contracts for the shared quota text render: every surface (Discord, CLI)
// shows the same truth, failures are named loudly, and thresholds mark rows.

import { feature, unit, expect } from "bdd-vitest";
import { formatLimitedAlert, formatQuotaSnapshot, formatReset } from "./quota-format.mjs";

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
      expect(claude).toContain("week 13%");
      expect(claude).toContain("week Fable 16%");
      expect(codex).toContain("week 70%");
    }],
  });

  unit("session carries its own reset; the weekly rows share one suffix", {
    when: ["rendering the Claude line", () => formatQuotaSnapshot(SNAPSHOT).split("\n")[1]],
    then: ["two reset stamps appear: the session's own and the shared weekly one", (claude) => {
      expect(claude).toContain("session 9% (reset Jul 15");
      expect(claude).toContain("(reset Jul 22");
    }],
  });

  unit("marks 70%+ as high and 90%+ as critical, in words", {
    when: ["rendering elevated percentages", () => formatQuotaSnapshot(withClaudePercents(9, 71, 93))],
    then: ["rows at the thresholds are marked, calm rows are not", (text) => {
      expect(text).toContain("week 71% (high)");
      expect(text).toContain("week Fable 93% (critical)");
      expect(text).not.toContain("session 9% (high)");
    }],
  });

  unit("a failed Claude read is named loudly while Codex still renders", {
    when: ["rendering with a typed Claude error", () =>
      formatQuotaSnapshot({ ...SNAPSHOT, claude: { ok: false, error: "credentials_expired" } })],
    then: ["the error is named, the healthy engine is unaffected", (text) => {
      expect(text).toContain("Claude  unavailable (credentials_expired)");
      expect(text).toContain("week 70%");
    }],
  });

  unit("a failed Codex read is named loudly while Claude still renders", {
    when: ["rendering with a typed Codex error", () =>
      formatQuotaSnapshot({ ...SNAPSHOT, codex: { ok: false, error: "no_session_files" } })],
    then: ["the error is named, the healthy engine is unaffected", (text) => {
      expect(text).toContain("Codex   unavailable (no_session_files)");
      expect(text).toContain("week Fable 16%");
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
      expect(text.match(/ · same login /gu)).toHaveLength(2);
      expect(text).toContain("Vecka 100% (critical)");
      expect(text).toContain("5 h 20%");
      expect(text).not.toContain("gränser");
    }],
  });
});

feature("one Claude line per account", () => {
  const claudeAccount = (email, sharedBy, extra = {}) => ({
    ok: true, provider: "claude", profile: { id: sharedBy[0].id, key: sharedBy[0].key },
    account: { email, plan: "max" }, sharedBy,
    limits: [{ kind: "session", usedPercent: 10, resetsAt: null }],
    ...extra,
  });

  unit("an account on two slots is one line naming both; a login dir is a slot unless a numbered slot shadows it", {
    when: ["rendering slot 1+2 on adelost, a free login and a dead login", () => formatQuotaSnapshot({
      accounts: [
        claudeAccount("adelost@example.com", [
          { id: "1", key: "claude:1", source: "primary" },
          { id: "2", key: "claude:2", source: "configured" },
        ]),
        claudeAccount("wetterlind@example.com", [
          { id: "wetterlind", key: "claude:login:wetterlind", source: "login" },
        ]),
        claudeAccount("attrois@example.com", [{ id: "2", key: "claude:login:2", source: "login" }],
          { ok: false, error: "login_expired", limits: undefined, account: { email: "attrois@example.com" } }),
      ],
    })],
    then: ["three Claude lines named by login, with their slots, and no duplicate warning", (text) => {
      const lines = text.split("\n").filter((line) => line.startsWith("Claude"));
      // adelost and attrois share an initial, so both keep their whole login.
      expect(lines).toEqual([
        "Claude adelost · slot 1+2 · adelost@example.com · max  session 10%",
        "Claude W · slot wetterlind · wetterlind@example.com · max  session 10%",
        "Claude attrois · no slot · attrois@example.com  unavailable (login_expired)",
      ]);
      expect(text).not.toContain("same login");
    }],
  });
});

feature("a login's subscription in the detail lines", () => {
  unit("the renewal date and free resets show with their read day, and file problems are named", {
    when: ["rendering one account with an entry and a file with a typo", () => formatQuotaSnapshot({
      accounts: [{ ok: false, provider: "codex", error: "network_error", profile: { id: "2", key: "codex:2" },
        account: { email: "wetterlind@example.com", plan: "prolite" }, name: "Codex W",
        subscription: { renewsOn: "2026-11-05", freeResetsLeft: 1, freeResetsReadOn: "2026-10-17" } }],
      accountFileProblems: ["claude:adelost: subscription.renewsOn needs YYYY-MM-DD"],
    }).split("\n")],
    then: ["both are on the account line and the problem trails", (lines) => {
      expect(lines[1]).toBe("Codex W · slot 2 · wetterlind@example.com · prolite · renews 2026-11-05 · free resets 1 (read 2026-10-17)  unavailable (network_error)");
      expect(lines.at(-1)).toBe("account-profiles.json: claude:adelost: subscription.renewsOn needs YYYY-MM-DD");
    }],
  });
});

feature("stop notice for a pane that hit its plan limit", () => {
  const logCommand = "amux log lsrc -p 1 --tmux";
  unit("names the reset and the automatic resume", {
    when: ["lsrc:1 stops until 03:10 with recovery on", () => formatLimitedAlert({
      paneKey: "lsrc:1", resetAt: new Date(2026, 8, 28, 3, 10).getTime(), autoResume: true, logCommand })],
    then: ["the channel and the phone both get the reset time", ({ discord, push }) => {
      expect(discord).toBe("**lsrc:1 has stopped, its quota is used up (reset Sep 28 03:10).** amux continues it in the same session when the window is back. The pane: `amux log lsrc -p 1 --tmux`");
      expect(push).toBe("lsrc:1 has stopped on quota, reset Sep 28 03:10. amux continues it by itself.");
    }],
  });

  unit("asks for a nudge when nothing resumes the pane", {
    when: ["a stop without a known reset and recovery off", () => formatLimitedAlert({ paneKey: "ai:4", logCommand })],
    then: ["no invented time and an honest next step", ({ discord, push }) => {
      expect(discord).toBe("**ai:4 has stopped, its quota is used up.** Nudge it when the quota is back. The pane: `amux log lsrc -p 1 --tmux`");
      expect(push).toBe("ai:4 has stopped on quota. Nudge it.");
    }],
  });
});
