import { expect, feature, unit } from "bdd-vitest";
import { compactBeforeStop, stopCompactLimit } from "./stop-compact.mjs";

const pane = (index, engine = "claude") => ({ agent: { name: "skydive" }, pane: { index }, engine, paneDir: `/pane/${index}` });

// Mattias 2026-09-27: a stop script killed skydive:1 at 153k one minute after its
// turn; the next start had to read the whole context cold.
function harness(factsByPane) {
  const runs = [];
  return {
    runs,
    deps: {
      agents: [{ name: "skydive", backend: "tmux" }],
      discover: async () => Object.keys(factsByPane).map((index) => pane(Number(index), factsByPane[index].engine)),
      observe: async (_ctx, target) => factsByPane[target.pane.index],
      run: async (_ctx, _flags, options) => {
        runs.push({ pane: options.targets[0].pane.index, maxTokens: options.policy.maxTokens });
        return { rows: [{ pane: `skydive:${options.targets[0].pane.index}`, status: "within-budget" }] };
      },
      queue: {},
    },
  };
}

feature("amux stop compacts large panes while their cache is warm", () => {
  unit("a warm pane over 80k is compacted before stop and a small one is left alone", {
    given: ["skydive:1 at 153k one minute after its turn, skydive:2 at 40k", () => harness({
      1: { running: true, tokens: 153_000, idleMs: 60_000 },
      2: { running: true, tokens: 40_000, idleMs: 60_000 },
    })],
    when: ["stopping skydive", async ({ deps, runs }) => { await compactBeforeStop({}, "skydive", deps); return runs; }],
    then: ["only the large pane gets one verified compact under the warm limit", (runs) => {
      expect(runs).toEqual([{ pane: 1, maxTokens: 80_000 }]);
    }],
  });

  unit("a cold pane is compacted only above the 210k cold limit", {
    given: ["two panes idle for two hours, at 153k and 250k", () => harness({
      0: { running: true, tokens: 153_000, idleMs: 2 * 3_600_000 },
      1: { running: true, tokens: 250_000, idleMs: 2 * 3_600_000 },
    })],
    when: ["stopping skydive", async ({ deps, runs }) => { await compactBeforeStop({}, "skydive", deps); return runs; }],
    then: ["the compact that costs more than it saves is skipped", (runs) => {
      expect(runs).toEqual([{ pane: 1, maxTokens: 210_000 }]);
    }],
  });

  unit("panes that are not running, unmeasured or not Claude/Codex are not touched", {
    given: ["a stopped pane, a pane with unknown tokens and a Kimi pane", () => harness({
      0: { running: false, tokens: 300_000, idleMs: 60_000 },
      1: { running: true, tokens: null, idleMs: 60_000 },
      2: { running: true, tokens: 300_000, idleMs: 60_000, engine: "kimi" },
    })],
    when: ["stopping skydive", async ({ deps, runs }) => { await compactBeforeStop({}, "skydive", deps); return runs; }],
    then: ["no compact is attempted", (runs) => { expect(runs).toEqual([]); }],
  });

  // The first wiring passed getAgent()'s entry, which has no backend, so the
  // target search took skydive for a native agent and found no panes at all.
  unit("stop looks the agent up in the normalized list, so its tmux panes are searched", {
    given: ["a normalized skydive entry and a discover spy", () => {
      const seen = [];
      return { seen, deps: { agents: [{ name: "skydive", backend: "tmux" }], queue: {},
        discover: async (_ctx, agents) => { seen.push(...agents.map((agent) => agent.backend)); return []; } } };
    }],
    when: ["stopping skydive", async ({ seen, deps }) => { await compactBeforeStop({}, "skydive", deps); return seen; }],
    then: ["the search sees a tmux agent", (seen) => { expect(seen).toEqual(["tmux"]); }],
  });

  unit("unknown idle time counts as a cold cache", {
    when: ["asking for the limit without an activity clock", () => stopCompactLimit(null)],
    then: ["the cold limit applies", (limit) => { expect(limit).toBe(210_000); }],
  });
});
