import { feature, unit, expect } from "bdd-vitest";
import { profileLoginInstruction, quotaAccountCatalog, quotaProfileCatalog } from "./quota-profiles.mjs";
import { resolveRuntimeProfile, runtimeProfileCatalog, runtimeProfileLaunchHome } from "./runtime-account-profiles.mjs";

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

  unit("launch slots and their homes do not change when more logins exist", {
    when: ["resolving the runtime catalog next to the same login dirs", () =>
      runtimeProfileCatalog("claude", { HOME: "/home/matt" }, loginDirsFs)],
    then: ["only slots 1 and 2 can launch, with the same homes as before", (catalog) => {
      expect(catalog.map((row) => row.id)).toEqual(["1", "2"]);
      expect(catalog.map(runtimeProfileLaunchHome)).toEqual([null, `${ROOT}/adelost`]);
      expect(resolveRuntimeProfile("claude", "wetterlind", catalog)).toBeNull();
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
