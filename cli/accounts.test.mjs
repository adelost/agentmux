import { feature, unit, expect } from "bdd-vitest";
import { cmdAccounts, runQuotaCommand } from "./accounts.mjs";

feature("account subscription CLI", () => {
  unit("routes a Codex pane switch and dry-run through the shared safe account path", {
    when: ["requesting an explicit target without running a provider", async () => {
      const calls = [], ctx = { agent: {}, deliveryQueue: {} };
      const result = await cmdAccounts(["switch", "codex:2", "claw", "-p", "5", "--dry"], ctx,
        { switchCodex: async (...args) => { calls.push(args); return { status: "DRY-RUN" }; } });
      return { result, calls, ctx };
    }],
    then: ["the exact pane and nonmutating mode reach the existing boundary", ({ result, calls, ctx }) => {
      expect(result.status).toBe("DRY-RUN");
      expect(calls).toEqual([[ctx, ["codex:2", "claw", "-p", "5", "--dry"]]]);
    }],
  });

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

  // lsrc:0 for api:0, 2026-10-27: the credit guard's week is read in amux quota, beside the credit balance.
  unit("amux quota ends with what the Codex credit guard did in the last seven days", {
    given: ["a snapshot and a guard log with one stopped turn that drew 1.2 credits", () => {
      const lines = [];
      return { lines, readSnapshot: async () => ({ schemaVersion: 2, accounts: [], claude: { ok: false, error: "x" }, codex: { ok: false, error: "y" }, kimi: { ok: false, error: "z" } }),
        boxText: () => "BOX", creditGuard: () => ({ stopped: 1, ownerTurns: 0, credits: 1.2 }), output: line => lines.push(line) };
    }],
    when: ["running the plain view", async ctx => { await runQuotaCommand([], ctx); return ctx.lines[0]; }],
    then: ["the last line says so", text => expect(text.split("\n").at(-1)).toBe("Codex credit guard, 7 days: 1 stopped, 0 owner turns left running, 1.2 credits drawn")],
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

  unit("plain quota includes today's unique shadow-flagged reply count on one line", {
    given: ["a fixed shadow measurement and ordinary quota output", () => ({ lines: [],
      readSnapshot: async () => ({ schemaVersion: 2, accounts: [], claude: { ok: false }, codex: { ok: false }, kimi: { ok: false } }),
      boxText: () => "BOX", creditGuard: () => ({ stopped: 0, ownerTurns: 0, credits: 0 }),
      claimShadowLine: () => "Skuggmätning idag (UTC): 7 flaggade svar" })],
    when: ["reading the normal quota view", async f => { await runQuotaCommand([], { ...f, output: text => f.lines.push(text) }); return f.lines[0]; }],
    then: ["one measurement line is present and the existing credit summary remains last", text => {
      expect(text.split("\n").filter(line => line === "Skuggmätning idag (UTC): 7 flaggade svar")).toHaveLength(1);
      expect(text.split("\n").at(-1)).toContain("Codex credit guard");
    }],
  });

  unit("login accepts a login dir, its email or a new login name", {
    given: ["slots plus the wetterlind login dir", () => {
      const lines = [];
      return {
        lines,
        output: (line) => lines.push(line),
        prepare: () => {},
        identityOf: (profile) => (profile.id === "wetterlind" ? { email: "wetterlind@example.test" } : null),
        newLogin: (name) => ({ provider: "claude", id: name, key: `claude:login:${name}`, home: `/profiles/claude/${name}`, source: "login" }),
        catalog: [
          { provider: "claude", id: "1", key: "claude:1", home: "/home/.claude", source: "primary" },
          { provider: "claude", id: "wetterlind", key: "claude:login:wetterlind", home: "/profiles/claude/wetterlind", source: "login" },
        ],
      };
    }],
    when: ["logging in by dir name, by email and by a new name", async (ctx) => [
      await cmdAccounts(["login", "claude:wetterlind"], ctx),
      await cmdAccounts(["login", "claude:wetterlind@example.test"], ctx),
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
