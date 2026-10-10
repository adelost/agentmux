// Contracts for "which account is in use right now": read from the running
// engine process, shown under each account, logged-out leftovers collapsed.

import { feature, unit, expect } from "bdd-vitest";
import { engineHomeOfPane, parsePaneList, withPanesInUse } from "./quota-in-use.mjs";
import { formatQuotaSnapshot } from "./quota-format.mjs";

// A fake /proc: pane shell 10 runs claude 11 on a login dir, shell 20 runs codex 21 on its default home.
const PROC = {
  "/proc/10/task/10/children": "11", "/proc/11/comm": "claude",
  "/proc/11/environ": "PATH=/bin\0CLAUDE_CONFIG_DIR=/p/claude/adelost\0",
  "/proc/20/task/20/children": "21", "/proc/21/comm": "node", "/proc/21/task/21/children": "22",
  "/proc/22/comm": "codex", "/proc/22/environ": "PATH=/bin\0",
};
const readFile = (path) => {
  if (!(path in PROC)) throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
  return PROC[path];
};

const PROFILES = [
  { provider: "codex", key: "codex:1", home: "/h/.codex" },
  { provider: "codex", key: "codex:2", home: "/p/codex/2" },
  { provider: "claude", key: "claude:1", home: "/h/.claude" },
  { provider: "claude", key: "claude:2", home: "/p/claude/adelost" },
  { provider: "claude", key: "claude:login:wetterlind", home: "/p/claude/wetterlind" },
  { provider: "claude", key: "claude:login:2", home: "/p/claude/2" },
  { provider: "kimi", key: "kimi:1", home: "/h/.kimi-code" },
  { provider: "kimi", key: "kimi:2", home: "/p/kimi/2" },
];
const week = (usedPercent) => [{ kind: "weekly_all", usedPercent, resetsAt: "2026-10-14T00:00:00Z" }];
const SNAPSHOT = {
  accounts: [
    { ok: true, provider: "codex", profile: { id: "1", key: "codex:1" }, account: { email: "w@x", plan: "prolite" },
      limits: [{ windows: [{ usedPercent: 9, windowMinutes: 10_080 }] }] },
    { ok: true, provider: "claude", profile: { id: "1", key: "claude:1" }, account: { email: "adelost@x", plan: "max" },
      limits: week(30), sharedBy: [{ id: "1", key: "claude:1", source: "primary" }, { id: "2", key: "claude:2", source: "configured" }] },
    { ok: true, provider: "claude", profile: { id: "wetterlind", key: "claude:login:wetterlind" }, account: { email: "wetterlind@x", plan: "max" },
      limits: week(82), sharedBy: [{ id: "wetterlind", key: "claude:login:wetterlind", source: "login" }] },
    { ok: false, provider: "claude", error: "login_expired", profile: { id: "2", key: "claude:login:2" }, account: { email: "attrois@x" },
      sharedBy: [{ id: "2", key: "claude:login:2", source: "login" }] },
    { ok: false, provider: "kimi", error: "credentials_expired", profile: { id: "1", key: "kimi:1" } },
    { ok: false, provider: "kimi", error: "credentials_expired", profile: { id: "2", key: "kimi:2" } },
  ],
};
const LIVE = [
  { key: "api:0", engine: "claude", home: "/p/claude/adelost" }, { key: "api:1", engine: "claude", home: "/p/claude/adelost" },
  { key: "api:2", engine: "claude", home: "/p/claude/adelost" }, { key: "claw:0", engine: "claude", home: "/h/.claude" },
  { key: "lsrc:3", engine: "codex", home: "/h/.codex" },
];
const identity = { realpath: (path) => path };

feature("which account each running pane spends", () => {
  unit("finds the engine under the pane shell and the login dir it runs on", {
    when: ["reading two pane trees", () => [engineHomeOfPane(10, { readFile, home: "/h" }), engineHomeOfPane(20, { readFile, home: "/h" })]],
    then: ["Claude names its config dir, Codex without CODEX_HOME runs on ~/.codex", ([claude, codex]) => {
      expect(claude).toEqual({ engine: "claude", home: "/p/claude/adelost" });
      expect(codex).toEqual({ engine: "codex", home: "/h/.codex" });
    }],
  });

  unit("parses one tmux list for every pane", {
    when: ["parsing a list with a broken row", () => parsePaneList("api\t0\t10\napi\tx\t11\nlsrc\t3\t20\n")],
    then: ["only well-formed rows remain", (panes) => expect(panes).toEqual([{ key: "api:0", pid: 10 }, { key: "lsrc:3", pid: 20 }])],
  });

  unit("shows the panes under each account and collapses logged-out leftovers", {
    when: ["rendering the snapshot with live panes", () =>
      formatQuotaSnapshot(withPanesInUse(SNAPSHOT, LIVE, PROFILES, identity)).split("\n")],
    then: ["the account in use is obvious and attrois/Kimi take one line", (lines) => {
      expect(lines[1]).toMatch(/^Codex 1 · w@x/u);
      expect(lines[2]).toBe("  i bruk: lsrc:3");
      expect(lines[3]).toMatch(/^Claude 1\+2 · adelost@x/u);
      expect(lines[4]).toBe("  i bruk: api:0–2, claw:0");
      expect(lines[5]).toMatch(/^Claude · wetterlind@x · max · ingen plats/u);
      expect(lines[6]).toBe("  ingen panel");
      expect(lines.at(-1)).toBe("Utloggade: Claude attrois · Kimi 1 · Kimi 2");
      expect(lines.join("\n")).not.toContain("otillgänglig");
    }],
  });

  unit("keeps a logged-out account on its own line while a pane runs on it", {
    when: ["a Kimi pane runs on an expired login", () => formatQuotaSnapshot(withPanesInUse(SNAPSHOT,
      [{ key: "api:7", engine: "kimi", home: "/h/.kimi-code" }], PROFILES, identity))],
    then: ["the failure stays visible next to its pane", (text) => {
      expect(text).toContain("Kimi 1  otillgänglig (credentials_expired)\n  i bruk: api:7");
      expect(text).toContain("Utloggade: Claude attrois · Kimi 2");
    }],
  });

  unit("names a pane on a dir no profile knows instead of hiding it", {
    when: ["a Claude pane runs on an unknown dir", () => formatQuotaSnapshot(withPanesInUse(SNAPSHOT,
      [{ key: "x:1", engine: "claude", home: "/tmp/other" }], PROFILES, identity))],
    then: ["it is listed with its dir", (text) => expect(text).toContain("Paneler på en inloggning amux inte känner: x:1 (/tmp/other)")],
  });
});
