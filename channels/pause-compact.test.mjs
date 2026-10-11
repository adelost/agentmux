import { component, expect, feature } from "bdd-vitest";
import { createPauseCompact } from "./pause-compact.mjs";

const NOW = Date.parse("2026-10-11T03:36:00Z");
const lsrc = { name: "lsrc", orchestrator: 3, leaders: [0] };

function controller(mode, { compacted = true } = {}) {
  let now = NOW;
  const runs = [], lines = [];
  const pause = createPauseCompact({ mode, now: () => now, state: { get: () => ({}) },
    contextMaintenance: { run: async (name, pane, options) => {
      runs.push({ pane: `${name}:${pane}`, ...options });
      return options.dry ? { ok: true, dry: true, cell: "compact-once", tokens: 710_858 } : { ok: compacted, compacted, cell: "compact-once" };
    } },
    record: line => lines.push(line),
    identityFor: () => ({ path: "/projects/lsrc-2/s1.jsonl", sessionId: "s1" }),
    backgroundFor: () => null, journalCompactFor: () => null });
  // lsrc:2's turn ended at 03:34:38, 82 s before the poll, like the night's last case.
  const poll = (facts = {}) => pause.consider({ agentConfig: lsrc, pane: 2, engine: "claude", paneDir: "/lsrc/.agents/2", status: "idle",
    inCopyMode: false, contextTokens: 710_858, lastActivityMs: NOW - 82_000, ...facts });
  return { runs, lines, poll, later: ms => { now += ms; } };
}

feature("pause compaction in the bridge poll", () => {
  component("a dry run logs one would-be compact per pause and sends nothing", {
    given: ["dry mode and lsrc:2 over budget at a pause", () => controller("dry")],
    when: ["polling three times a minute apart", async ctx => {
      const sent = [await ctx.poll()];
      ctx.later(60_000); sent.push(await ctx.poll());
      ctx.later(60_000); sent.push(await ctx.poll());
      return sent;
    }],
    then: ["one dry admission, one would-compact line, then the spacing hold", (sent, ctx) => {
      expect(sent).toEqual([false, false, false]);
      expect(ctx.runs).toEqual([{ pane: "lsrc:2", pauseTokens: 400_000, dry: true }]);
      expect(ctx.lines.map(line => `${line.outcome}:${line.cell}`)).toEqual(["would-compact:pause", "held:spacing"]);
      expect(ctx.lines[0]).toMatchObject({ pane: "lsrc:2", mode: "dry", tokens: 710_858, limit: 400_000, leader: false, quietSec: 82 });
    }],
  });
  component("a leader under 700k is left alone and nothing is logged", {
    given: ["dry mode", () => controller("dry")],
    when: ["polling lsrc:0 at 517k after its turn", ctx => ctx.poll({ pane: 0, contextTokens: 517_854 })],
    then: ["no admission, no line", (sent, ctx) => { expect(sent).toBe(false); expect(ctx.runs).toEqual([]); expect(ctx.lines).toEqual([]); }],
  });
  component("an idle builder under budget is never touched", {
    given: ["live mode", () => controller("on")],
    when: ["polling lsrc:2 at 300k, idle an hour", ctx => ctx.poll({ contextTokens: 300_000, lastActivityMs: NOW - 3_600_000 })],
    then: ["no admission", (sent, ctx) => { expect(sent).toBe(false); expect(ctx.runs).toEqual([]); }],
  });
  component("live mode compacts and tells the 50-minute rule it did", {
    given: ["live mode", () => controller("on")],
    when: ["polling lsrc:2 at the pause", ctx => ctx.poll()],
    then: ["one compact with the builder budget, logged", (sent, ctx) => {
      expect(sent).toBe(true);
      expect(ctx.runs).toEqual([{ pane: "lsrc:2", pauseTokens: 400_000, dry: false }]);
      expect(ctx.lines.map(line => line.outcome)).toEqual(["compacted"]);
    }],
  });
  component("off mode does nothing", {
    given: ["off mode", () => controller("off")],
    when: ["polling lsrc:2 at the pause", ctx => ctx.poll()],
    then: ["no admission, no line", (sent, ctx) => { expect(sent).toBe(false); expect(ctx.runs).toEqual([]); expect(ctx.lines).toEqual([]); }],
  });
});
