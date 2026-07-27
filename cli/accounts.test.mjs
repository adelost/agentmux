import { feature, unit, expect } from "bdd-vitest";
import { cmdAccounts, runQuotaCommand } from "./accounts.mjs";

feature("account subscription CLI", () => {
  unit("renders all account rows by default and emits JSON only on request", {
    given: ["a six-account snapshot and output capture", () => {
      const snapshot = { schemaVersion: 2, accounts: [], claude: { ok: false, error: "x" },
        codex: { ok: false, error: "y" }, kimi: { ok: false, error: "z" } };
      const lines = [];
      return { snapshot, lines, readSnapshot: async () => snapshot, output: (line) => lines.push(line) };
    }],
    when: ["running the explicit JSON view", async (ctx) => {
      await runQuotaCommand(["--all", "--json"], ctx);
      return ctx;
    }],
    then: ["the machine-readable shared schema is printed", (ctx) => {
      expect(JSON.parse(ctx.lines[0])).toEqual(ctx.snapshot);
    }],
  });

  unit("prints a provider-scoped login instruction without credentials", {
    given: ["one isolated Claude profile", () => {
      const lines = [];
      return { lines, output: (line) => lines.push(line), catalog: [{
        provider: "claude", id: "2", key: "claude:2", label: "Claude 2",
        home: "/profiles/claude/2", source: "isolated",
      }] };
    }],
    when: ["requesting its login command", async (ctx) => {
      await cmdAccounts(["login", "claude:2"], ctx);
      return ctx.lines[0];
    }],
    then: ["the profile path is explicit and no token value is present", (line) => {
      expect(line).toContain("CLAUDE_CONFIG_DIR='/profiles/claude/2' claude auth login");
      expect(line.toLowerCase()).not.toContain("access_token");
    }],
  });
});
