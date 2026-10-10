import { feature, unit, expect } from "bdd-vitest";
import { createAccountSwitchCommand, parseSwitchArgs } from "./account-switch-command.mjs";

const OPERATOR = "111";
const rows = (status) => [{ key: "api:0", status }, { key: "lsrc:0", status: "would-compact-then-restart" }];

// One bridge: a memory state, a clock and a rotation whose dry plan the test can change.
const bridge = ({ planStatus = "would-running" } = {}) => {
  const data = {}, calls = [], replies = [];
  const world = { clock: 0, planStatus };
  const command = createAccountSwitchCommand({
    state: { get: (key, fallback) => (key in data ? data[key] : fallback), set: (key, value) => { data[key] = value; } },
    runtime: () => ({ agent: {}, deliveryQueue: {} }),
    operatorId: () => OPERATOR,
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
      expect(ctx.replies[0]).toContain("Inget är ändrat. Byt med `/byt wetterlind ok` inom 10 min.");
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
      expect(ctx.replies.at(-1)).toContain("Planen var inte visad de senaste 10 minuterna");
    }],
  });

  unit("a confirm after a pane's verdict changed shows the new plan", {
    given: ["a shown plan, then api:0 becomes blocked", async () => {
      const ctx = bridge(); await ctx.say("wetterlind"); ctx.world.planStatus = "blocked"; return ctx;
    }],
    when: ["confirming", async (ctx) => { await ctx.say("wetterlind ok"); return ctx; }],
    then: ["nothing switched", (ctx) => {
      expect(realRuns(ctx)).toEqual([]);
      expect(ctx.replies.at(-1)).toContain("Planen har ändrats sedan du såg den");
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
      expect(ctx.replies.at(-1)).toBe("Bara operatören kan bekräfta ett kontobyte.");
    }],
  });
});
