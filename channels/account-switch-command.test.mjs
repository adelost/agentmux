import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { feature, unit, component, expect } from "bdd-vitest";
import { createAccountSwitchCommand, parseSwitchArgs } from "./account-switch-command.mjs";

const OPERATOR = "111";
const rows = (status) => [{ key: "api:0", status }, { key: "lsrc:0", status: "would-compact-then-restart" }];

// One bridge: a memory state, a clock and a rotation whose dry plan the test can change.
const bridge = ({ planStatus = "would-running", env } = {}) => {
  const data = {}, calls = [], replies = [];
  const world = { clock: 0, planStatus };
  const command = createAccountSwitchCommand({
    state: { get: (key, fallback) => (key in data ? data[key] : fallback), set: (key, value) => { data[key] = value; } },
    runtime: () => ({ agent: {}, deliveryQueue: {} }),
    operatorId: () => OPERATOR,
    env,
    now: () => world.clock,
    rotate: async (_ctx, target, { dry }, { output }) => {
      calls.push({ target, dry });
      output(`${dry ? "DRY-RUN" : "RECOVERED"} claude:${target}`);
      return { status: dry ? "DRY-RUN" : "RECOVERED", rows: rows(dry ? world.planStatus : "running") };
    },
  });
  const say = (text, authorId = OPERATOR) => command({ authorId, reply: async (reply) => replies.push(reply) }, null, 0, text);
  return { world, calls, replies, say };
};
const realRuns = (ctx) => ctx.calls.filter((call) => !call.dry);

feature("Discord /byt account switch", () => {
  component("defect: Attrois keeps its saved Claude S name through preview and confirmation", {
    given: ["a login in a historically named directory and its saved account names", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-byt-name-"));
      const home = join(root, "adelost"), labels = join(root, "profiles.json");
      mkdirSync(home);
      writeFileSync(join(home, ".claude.json"), JSON.stringify({ oauthAccount: { emailAddress: "attrois@example.test" } }));
      writeFileSync(labels, JSON.stringify({ version: 2, slots: { "claude:2": { home } },
        accounts: { "claude:attrois": { name: "Claude S" }, "claude:adelost": { name: "Claude A" } } }));
      return { root, ...bridge({ env: { AMUX_ACCOUNT_LABELS_FILE: labels,
        AMUX_ACCOUNT_PROFILES_DIR: root, AMUX_CLAUDE_PROFILE_2_HOME: home } }) };
    }],
    when: ["previewing login, email and slot, then confirming the login", async (ctx) => {
      for (const target of ["attrois", "attrois@example.test", "2"]) await ctx.say(target);
      ctx.previewRuns = realRuns(ctx).length;
      await ctx.say("attrois ok");
      return ctx;
    }],
    then: ["all five replies name Claude S and previews never switch", (ctx) => {
      expect(ctx.previewRuns).toBe(0);
      expect(ctx.replies.map((reply) => reply.split("\n")[0])).toEqual([
        "Plan to switch to **Claude S**:", "Plan to switch to **Claude S**:", "Plan to switch to **Claude S**:",
        "Switching to **Claude S** now. Large active panes are compacted first.", "Result of the switch to **Claude S**:",
      ]);
      expect(realRuns(ctx)).toEqual([{ target: "attrois", dry: false }]);
    }],
    cleanup: (ctx) => rmSync(ctx.root, { recursive: true, force: true }),
  });

  unit("parses exactly <target> or <target> ok", {
    when: ["parsing forms", () => ["wetterlind", "wetterlind ok", "wetterlind OK", "", "a b c"].map(parseSwitchArgs)],
    then: ["only those two shapes are accepted", (parsed) => expect(parsed).toEqual([
      { target: "wetterlind", confirm: false }, { target: "wetterlind", confirm: true },
      { target: "wetterlind", confirm: true }, null, null])],
  });

  unit("the plan reply changes nothing and names the confirm", {
    given: ["a bridge", () => bridge()],
    when: ["asking for the plan", async (ctx) => { await ctx.say("wetterlind"); return ctx; }],
    then: ["only a dry run happened", (ctx) => {
      expect(ctx.calls).toEqual([{ target: "wetterlind", dry: true }]);
      expect(ctx.replies[0]).toContain("Plan to switch to **Claude W**:");
      expect(ctx.replies[0]).toContain("Nothing has changed. Switch with `/byt wetterlind ok` within 10 min.");
    }],
  });

  unit("the operator's confirm of an unchanged plan runs the switch", {
    given: ["a shown plan", async () => { const ctx = bridge(); await ctx.say("wetterlind"); ctx.world.clock = 5 * 60_000; return ctx; }],
    when: ["confirming", async (ctx) => { await ctx.say("wetterlind ok"); return ctx; }],
    then: ["one real rotation and its outcome reply", (ctx) => {
      expect(realRuns(ctx)).toEqual([{ target: "wetterlind", dry: false }]);
      expect(ctx.replies.at(-1)).toContain("RECOVERED claude:wetterlind");
    }],
  });

  unit("a confirm older than ten minutes shows the plan again", {
    given: ["a plan shown eleven minutes ago", async () => { const ctx = bridge(); await ctx.say("wetterlind"); ctx.world.clock = 11 * 60_000; return ctx; }],
    when: ["confirming late", async (ctx) => { await ctx.say("wetterlind ok"); return ctx; }],
    then: ["nothing switched", (ctx) => {
      expect(realRuns(ctx)).toEqual([]);
      expect(ctx.replies.at(-1)).toContain("The plan was not shown in the last 10 minutes");
    }],
  });

  unit("a confirm after a pane's verdict changed shows the new plan", {
    given: ["a shown plan, then api:0 becomes blocked", async () => {
      const ctx = bridge(); await ctx.say("wetterlind"); ctx.world.planStatus = "blocked"; return ctx;
    }],
    when: ["confirming", async (ctx) => { await ctx.say("wetterlind ok"); return ctx; }],
    then: ["nothing switched", (ctx) => {
      expect(realRuns(ctx)).toEqual([]);
      expect(ctx.replies.at(-1)).toContain("The plan has changed since you saw it");
    }],
  });

  unit("a confirm without a shown plan only shows it", {
    given: ["a bridge", () => bridge()],
    when: ["confirming first", async (ctx) => { await ctx.say("wetterlind ok"); return ctx; }],
    then: ["nothing switched", (ctx) => expect(realRuns(ctx)).toEqual([])],
  });

  unit("someone else cannot confirm", {
    given: ["a shown plan", async () => { const ctx = bridge(); await ctx.say("wetterlind"); return ctx; }],
    when: ["another user confirms", async (ctx) => { await ctx.say("wetterlind ok", "999"); return ctx; }],
    then: ["refused before any rotation", (ctx) => {
      expect(realRuns(ctx)).toEqual([]);
      expect(ctx.replies.at(-1)).toBe("Only the operator can confirm an account switch.");
    }],
  });
});
