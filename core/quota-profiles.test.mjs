import { feature, unit, expect } from "bdd-vitest";
import { profileLoginInstruction, quotaProfileCatalog } from "./quota-profiles.mjs";

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
