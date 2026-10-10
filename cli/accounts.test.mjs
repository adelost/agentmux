import { feature, unit, expect } from "bdd-vitest";
import { cmdAccounts, runQuotaCommand } from "./accounts.mjs";

feature("account subscription CLI", () => {
  unit("help is offline and does not refresh credentials", {
    given: ["read functions forbidden", () => ({ output: () => {}, readSnapshot: () => { throw new Error("network forbidden"); } })],
    when: ["reading both help entries", async options => [await runQuotaCommand(["--help"], options), await cmdAccounts(["--help"], options)]],
    then: ["both return help without quota collection", results => expect(results).toEqual([{ help: true }, { help: true }])],
  });
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
      return {
        lines,
        output: (line) => lines.push(line),
        prepare: () => {},
        catalog: [{
          provider: "claude", id: "2", key: "claude:2", label: "Claude 2",
          home: "/profiles/claude/2", source: "isolated",
        }],
      };
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

  unit("login accepts a login dir, its email or a new login name", {
    given: ["slots plus the wetterlind login dir", () => {
      const lines = [];
      return {
        lines,
        output: (line) => lines.push(line),
        prepare: () => {},
        identityOf: (profile) => (profile.id === "wetterlind" ? { email: "mattias.wetterlind@gmail.com" } : null),
        newLogin: (name) => ({ provider: "claude", id: name, key: `claude:login:${name}`, home: `/profiles/claude/${name}`, source: "login" }),
        catalog: [
          { provider: "claude", id: "1", key: "claude:1", home: "/home/.claude", source: "primary" },
          { provider: "claude", id: "wetterlind", key: "claude:login:wetterlind", home: "/profiles/claude/wetterlind", source: "login" },
        ],
      };
    }],
    when: ["logging in by dir name, by email and by a new name", async (ctx) => [
      await cmdAccounts(["login", "claude:wetterlind"], ctx),
      await cmdAccounts(["login", "claude:mattias.wetterlind@gmail.com"], ctx),
      await cmdAccounts(["login", "claude:tredje"], ctx),
    ]],
    then: ["each prints its own dir and nothing touches slot 1", (results) => {
      expect(results.map((result) => result.instruction)).toEqual([
        "CLAUDE_CONFIG_DIR='/profiles/claude/wetterlind' claude auth login",
        "CLAUDE_CONFIG_DIR='/profiles/claude/wetterlind' claude auth login",
        "CLAUDE_CONFIG_DIR='/profiles/claude/tredje' claude auth login",
      ]);
    }],
  });

  unit("routes an explicit Claude dry-run to the fleet safety boundary", {
    given: ["a runtime context and injected rotation", () => {
      const calls = [];
      return {
        calls,
        runtime: { agent: {}, deliveryQueue: {} },
        rotate: async (...args) => { calls.push(args); return { status: "DRY-RUN" }; },
      };
    }],
    when: ["requesting a dry-run", async (ctx) => {
      ctx.result = await cmdAccounts(
        ["rotate", "claude:2", "--dry"],
        ctx.runtime,
        { rotate: ctx.rotate },
      );
    }],
    then: ["the provider id and non-mutating mode are exact", (_, ctx) => {
      expect(ctx.result.status).toBe("DRY-RUN");
      expect(ctx.calls).toEqual([[ctx.runtime, "2", { dry: true }]]);
    }],
  });
});
