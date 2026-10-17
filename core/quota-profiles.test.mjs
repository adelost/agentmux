import { feature, unit, expect } from "bdd-vitest";
import { accountEntries, profileLoginInstruction, quotaAccountCatalog, quotaProfileCatalog } from "./quota-profiles.mjs";
import { resolveClaudeAccountTarget, resolveRuntimeProfile, runtimeProfileCatalog, runtimeProfileLaunchHome } from "./runtime-account-profiles.mjs";

const ROOT = "/home/matt/.config/agent/account-profiles/claude";
// Four login dirs: one is slot 2's home, one holds no Claude login.
const loginDirsFs = {
  readDir: (path) => (path === ROOT
    ? ["adelost", "wetterlind", "2", "empty"].map((name) => ({ name, isDirectory: () => true }))
    : []),
  exists: () => false,
  realpath: (path) => path,
  readFile: (path) => {
    if (path === "/home/matt/.agentmux/account-profiles.json") {
      return JSON.stringify({ version: 1, profiles: { "claude:2": { home: `${ROOT}/adelost` } } });
    }
    if (path.endsWith("/empty/.credentials.json")) return "{}";
    if (path.endsWith(".credentials.json")) return JSON.stringify({ claudeAiOauth: {} });
    throw Object.assign(new Error("missing"), { code: "ENOENT" });
  },
};

feature("Claude logins outside the launch slots", () => {
  unit("a login dir in no slot is listed for quota as a login, not a slot", {
    when: ["building the account catalog", () =>
      quotaAccountCatalog({ HOME: "/home/matt" }, loginDirsFs)
        .filter((row) => row.provider === "claude")],
    then: ["both slots plus the two foreign logins, each once", (claude) => {
      expect(claude.map((row) => row.key)).toEqual([
        "claude:1", "claude:2", "claude:login:2", "claude:login:wetterlind",
      ]);
      expect(claude.find((row) => row.key === "claude:login:wetterlind")).toMatchObject({
        source: "login",
        credentialsPath: `${ROOT}/wetterlind/.credentials.json`,
        identityPath: `${ROOT}/wetterlind/.claude.json`,
      });
    }],
  });

  // Mattias 2026-10-10 asked to switch panes to the other account, which lives in a login dir, not a slot.
  unit("a login dir becomes a launch target by name while the slots keep their homes", {
    when: ["resolving the runtime catalog next to the same login dirs", () =>
      runtimeProfileCatalog("claude", { HOME: "/home/matt" }, loginDirsFs)],
    then: ["slots 1 and 2 are unchanged and wetterlind launches in its own dir", (catalog) => {
      expect(catalog.map((row) => row.id)).toEqual(["1", "2", "wetterlind"]);
      expect(catalog.map(runtimeProfileLaunchHome)).toEqual([null, `${ROOT}/adelost`, `${ROOT}/wetterlind`]);
      expect(resolveRuntimeProfile("claude", "2", catalog).home).toBe(`${ROOT}/adelost`);
    }],
  });

  unit("a rotation target can be named by the account email shown in amux quota", {
    given: ["slots 1 and 2 on adelost and wetterlind in a login dir", () =>
      runtimeProfileCatalog("claude", { HOME: "/home/matt" }, loginDirsFs)],
    when: ["resolving by email, case-insensitively", (catalog) => {
      const identityOf = (profile) => ({ email: profile.id === "wetterlind"
        ? "wetterlind@example.test" : "adelost@example.test" });
      return {
        wetterlind: resolveClaudeAccountTarget("Wetterlind@example.test", catalog, { identityOf }),
        adelost: resolveClaudeAccountTarget("adelost@example.test", catalog, { identityOf }),
        unknown: resolveClaudeAccountTarget("other@example.test", catalog, { identityOf }),
        // The box advises "/byt adelost" for Claude A, whose login dir is slot 2's home (2026-10-17).
        byLogin: resolveClaudeAccountTarget("adelost", catalog, { identityOf }),
        unknownLogin: resolveClaudeAccountTarget("other", catalog, { identityOf }),
      };
    }],
    then: ["the email or its login picks that account, a shared login its first slot, an absent one nothing", (found) => {
      expect(found.wetterlind.id).toBe("wetterlind");
      expect(found.adelost.id).toBe("1");
      expect(found.unknown).toBeNull();
      expect(found.byLogin.id).toBe("1");
      expect(found.unknownLogin).toBeNull();
    }],
  });
});

feature("subscription account profile catalog", () => {
  unit("keeps tokens provider-owned and discovers one Windows profile", {
    given: ["one Windows user with Claude and Kimi homes", () => {
      const dirs = new Set(["/mnt/c/Users/matt/.claude", "/mnt/c/Users/matt/.kimi-code"]);
      return quotaProfileCatalog({ HOME: "/home/matt" }, {
        readDir: () => [{ name: "matt", isDirectory: () => true }],
        exists: (path) => dirs.has(path),
      });
    }],
    then: ["six profiles expose paths, labels and sources but no token values", (catalog) => {
      expect(catalog).toHaveLength(6);
      expect(catalog.find((row) => row.key === "claude:2")).toMatchObject({
        home: "/mnt/c/Users/matt/.claude", source: "windows",
      });
      expect(catalog.find((row) => row.key === "kimi:2")).toMatchObject({
        home: "/mnt/c/Users/matt/.kimi-code", source: "windows",
      });
      expect(JSON.stringify(catalog)).not.toMatch(/accessToken|refreshToken|apiKey/u);
    }],
  });

  unit("explicit homes and labels win over discovery", {
    when: ["building with operator overrides", () => quotaProfileCatalog({
      HOME: "/home/matt",
      AMUX_CLAUDE_PROFILE_2_HOME: "/vault/claude-two",
      AMUX_CLAUDE_PROFILE_2_LABEL: "Work Max",
    }, { readDir: () => [], exists: () => false })],
    then: ["the selected profile is deterministic", (catalog) => {
      expect(catalog.find((row) => row.key === "claude:2")).toMatchObject({
        home: "/vault/claude-two", label: "Work Max",
      });
    }],
  });

  unit("loads non-secret operator labels outside the replaceable package", {
    when: ["building with a versioned account-profile file", () => quotaProfileCatalog({
      HOME: "/home/matt",
    }, {
      readDir: () => [],
      exists: () => false,
      readFile: (path) => {
        expect(path).toBe("/home/matt/.agentmux/account-profiles.json");
        return JSON.stringify({
          version: 1,
          profiles: {
            "codex:1": { label: "matt@example.com" },
            "kimi:2": { label: "work@example.com", home: "/profiles/kimi-two" },
          },
        });
      },
    })],
    then: ["the labels apply without moving provider-owned credentials", (catalog) => {
      expect(catalog.find((row) => row.key === "codex:1")).toMatchObject({
        label: "matt@example.com", home: "/home/matt/.codex",
      });
      expect(catalog.find((row) => row.key === "kimi:2")).toMatchObject({
        label: "work@example.com", home: "/profiles/kimi-two",
      });
    }],
  });

  unit("environment labels override the file and malformed files fail closed", {
    when: ["building once with both sources and once with invalid JSON", () => [
      quotaProfileCatalog({
        HOME: "/home/matt",
        AMUX_KIMI_PROFILE_1_LABEL: "explicit@example.com",
      }, {
        readDir: () => [], exists: () => false,
        readFile: () => JSON.stringify({
          version: 1,
          profiles: { "kimi:1": { label: "file@example.com" } },
        }),
      }),
      quotaProfileCatalog({ HOME: "/home/matt" }, {
        readDir: () => [], exists: () => false, readFile: () => "{",
      }),
    ]],
    then: ["the explicit value wins and invalid data cannot invent an identity", ([explicit, invalid]) => {
      expect(explicit.find((row) => row.key === "kimi:1")?.label).toBe("explicit@example.com");
      expect(invalid.find((row) => row.key === "kimi:1")?.label).toBe("kimi 1");
    }],
  });

  unit("login instructions scope the provider CLI without exposing credentials", {
    given: ["three profile homes", () => quotaProfileCatalog({ HOME: "/home/matt" }, {
      readDir: () => [], exists: () => false,
    }).filter((row) => row.id === "2")],
    then: ["each command binds the provider's native home", (profiles) => {
      expect(profileLoginInstruction(profiles[0])).toContain("CODEX_HOME=");
      expect(profileLoginInstruction(profiles[1])).toContain("CLAUDE_CONFIG_DIR=");
      expect(profileLoginInstruction(profiles[2])).toContain("KIMI_CODE_HOME=");
      expect(profileLoginInstruction(profiles[2])).toContain("kimi login");
    }],
  });

  unit("primary Claude login keeps its native identity path", {
    given: ["default and isolated Claude profiles", () =>
      quotaProfileCatalog({ HOME: "/home/matt" }, {
        readDir: () => [], exists: () => false,
      }).filter((row) => row.provider === "claude")],
    then: ["only the isolated login exports CLAUDE_CONFIG_DIR", ([primary, secondary]) => {
      expect(profileLoginInstruction(primary)).toBe("claude auth login");
      expect(profileLoginInstruction(secondary))
        .toBe("CLAUDE_CONFIG_DIR='/home/matt/.config/agent/account-profiles/claude/2' claude auth login");
    }],
  });
});

// lsrc:0 for Mattias 2026-10-17: one entry per login, the slot homes kept internal.
feature("account-profiles.json version 2", () => {
  const file = (document) => ({ readDir: () => [], exists: () => false, readFile: () => JSON.stringify(document) });
  const version2 = {
    version: 2,
    accounts: {
      "claude:adelost": { name: "Claude A", subscription: { renewsOn: "2026-11-12", freeResetsLeft: 0, freeResetsReadOn: "2026-10-17" } },
      "codex:adelost": { subscription: { freeResetsLeft: 1, freeResetsReadOn: "2026-10-17", freeResetsExpire: ["2026-10-29T20:24+01:00"] } },
      "codex:wetterlind": { subscription: { renewsOn: "2026-02-30", freeResetsLeft: 2, freeResetsExpire: ["Oct 29"] } },
      "claude:wetterlind": { subscription: { freeResetsExpire: ["2026-11-07T00:48+01:00"] } },
      "slot:1": { name: "not a login" },
    },
    slots: { "claude:2": { home: "/profiles/claude/adelost" } },
  };
  unit("slot homes stay internal and keep resolving", {
    when: ["building the catalog from a version 2 file", () => quotaProfileCatalog({ HOME: "/home/matt" }, file(version2))],
    then: ["slot 2 keeps its home and no slot carries a label from the file", (catalog) => {
      expect(catalog.find((row) => row.key === "claude:2")).toMatchObject({ home: "/profiles/claude/adelost", source: "configured", label: "claude 2" });
      expect(catalog.find((row) => row.key === "codex:1")?.label).toBe("codex 1");
    }],
  });
  unit("each login's entry is read, and every invalid field is named", {
    when: ["reading the entries", () => accountEntries({ HOME: "/home/matt" }, file(version2))],
    then: ["the valid entry is kept whole and the rest is reported", ({ entries, problems }) => {
      expect(entries.get("claude:adelost")).toEqual({ name: "Claude A",
        subscription: { renewsOn: "2026-11-12", freeResetsLeft: 0, freeResetsReadOn: "2026-10-17" } });
      expect(entries.get("codex:adelost")).toEqual({
        subscription: { freeResetsLeft: 1, freeResetsReadOn: "2026-10-17", freeResetsExpire: ["2026-10-29T20:24+01:00"] } });
      expect(entries.get("codex:wetterlind")).toEqual({});
      expect(entries.get("claude:wetterlind")).toEqual({});
      expect(problems).toEqual([
        "codex:wetterlind: subscription.renewsOn needs YYYY-MM-DD",
        "codex:wetterlind: subscription.freeResetsExpire needs a list of times like 2026-10-29T20:24+01:00",
        "codex:wetterlind: subscription.freeResetsLeft and freeResetsReadOn go together",
        "claude:wetterlind: subscription.freeResetsExpire goes with freeResetsLeft",
        "slot:1: not an engine:login entry",
      ]);
    }],
  });
  unit("a version 1 file still gives its slot homes and no entries", {
    when: ["reading a version 1 file", () => {
      const v1 = file({ version: 1, profiles: { "claude:2": { label: "old", home: "/profiles/claude/adelost" } } });
      return { catalog: quotaProfileCatalog({ HOME: "/home/matt" }, v1), entries: accountEntries({ HOME: "/home/matt" }, v1) };
    }],
    then: ["the home applies and there is nothing to name", ({ catalog, entries }) => {
      expect(catalog.find((row) => row.key === "claude:2")?.home).toBe("/profiles/claude/adelost");
      expect(entries.entries.size).toBe(0);
      expect(entries.problems).toEqual([]);
    }],
  });
});
