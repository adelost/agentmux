import { feature, unit, expect } from "bdd-vitest";
import { profileLoginInstruction, quotaProfileCatalog } from "./quota-profiles.mjs";

feature("subscription account profile catalog", () => {
  unit("keeps tokens provider-owned and discovers one Windows profile", {
    given: ["one Windows user with Claude and Gemini homes", () => {
      const dirs = new Set(["/mnt/c/Users/matt/.claude", "/mnt/c/Users/matt/.gemini"]);
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
      expect(catalog.find((row) => row.key === "gemini:2")).toMatchObject({
        home: "/mnt/c/Users/matt/.gemini", source: "windows",
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

  unit("login instructions scope the provider CLI without exposing credentials", {
    given: ["three profile homes", () => quotaProfileCatalog({ HOME: "/home/matt" }, {
      readDir: () => [], exists: () => false,
    }).filter((row) => row.id === "2")],
    then: ["each command binds the provider's native home", (profiles) => {
      expect(profileLoginInstruction(profiles[0])).toContain("CODEX_HOME=");
      expect(profileLoginInstruction(profiles[1])).toContain("CLAUDE_CONFIG_DIR=");
      expect(profileLoginInstruction(profiles[2])).toContain("GEMINI_CLI_HOME=");
    }],
  });
});
