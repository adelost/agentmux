import { feature, component, unit, expect } from "bdd-vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  collectDreamTargets,
  countDreamTurnsSince,
  emptyDreamReceipts,
  isDreamActivityTurn,
  planDreamActions,
  readDreamReceipts,
  recordDreamReceipt,
} from "./dream-eligibility.mjs";

feature("nightly dream activity boundary", () => {
  unit("ten new real turns gate memory while context only gates compact", {
    when: ["planning the boundary cases", () => ({
      unusedHighContext: planDreamActions({ turns: 0, contextPercent: 90 }),
      usedLowContext: planDreamActions({ turns: 10, contextPercent: 20 }),
      usedAtThreshold: planDreamActions({ turns: 10, contextPercent: 50 }),
      unknownContext: planDreamActions({ turns: 100, contextPercent: null }),
    })],
    then: ["unused panes never wake and every used pane writes memory", (plans) => {
      expect(plans.unusedHighContext).toMatchObject({ eligible: false, compact: false, memory: false });
      expect(plans.usedLowContext).toMatchObject({ eligible: true, compact: false, memory: true });
      expect(plans.usedAtThreshold).toMatchObject({ eligible: true, compact: true, memory: true });
      expect(plans.unknownContext).toMatchObject({ eligible: true, compact: false, memory: true });
    }],
  });

  unit("dream and compact plumbing cannot manufacture new activity", {
    when: ["classifying user-role text", () => ({
      human: isDreamActivityTurn("fixa den riktiga buggen"),
      delegated: isDreamActivityTurn("[from lsrc:2] reviewa PR #12"),
      dream: isDreamActivityTurn("[dream 2026-07-21 04:00] Läs filen först"),
      compact: isDreamActivityTurn("/compact"),
      recovery: isDreamActivityTurn("[AMUX AUTOMATIC CRASH RECOVERY · SAME SESSION] Fortsätt."),
    })],
    then: ["only genuine work directives count", (result) => {
      expect(result).toEqual({ human: true, delegated: true, dream: false, compact: false, recovery: false });
    }],
  });

  component("the real JSONL counter applies the dream-specific activity predicate", {
    given: ["one human turn surrounded by many maintenance turns", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-dream-jsonl-"));
      const previousHome = process.env.HOME;
      process.env.HOME = root;
      const paneDir = "/workspace/ai/.agents/1";
      const encoded = paneDir.replace(/[\/.]/g, "-");
      const projectDir = join(root, ".claude", "projects", encoded);
      mkdirSync(projectDir, { recursive: true });
      const turns = [
        ...Array.from({ length: 12 }, (_, index) => `[dream 2026-07-${10 + index} 04:00] summarize`),
        "/compact",
        "the one real instruction",
      ].map((content, index) => JSON.stringify({
        type: "user",
        timestamp: new Date(Date.parse("2026-07-20T00:00:00Z") + index * 60_000).toISOString(),
        message: { role: "user", content },
      }));
      writeFileSync(join(projectDir, "session.jsonl"), `${turns.join("\n")}\n`);
      return { root, previousHome, paneDir };
    }],
    when: ["counting through the production predicate", ({ paneDir }) =>
      countDreamTurnsSince(paneDir, null)],
    then: ["only the real instruction contributes", (result, fx) => {
      expect(result).toMatchObject({ count: 1, capped: false });
      process.env.HOME = fx.previousHome;
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });

  component("a successful receipt advances the cursor and prevents reusing the same ten turns", {
    given: ["one idle pane with ten turns after its old receipt", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-dream-receipt-"));
      const receiptPath = join(root, "dream-receipts.json");
      const oldCursor = "2026-07-20T10:00:00.000Z";
      const newCursor = "2026-07-21T10:00:00.000Z";
      const receipts = {
        schemaVersion: 1,
        panes: {
          "ai:0": { activityCursor: oldCursor, dreamedAt: oldCursor, dateKey: "2026-07-20" },
        },
      };
      const agents = [{ name: "ai", dir: "/workspace/ai", panes: [{ cmd: "claude" }] }];
      const observedCutoffs = [];
      return { root, receiptPath, oldCursor, newCursor, receipts, agents, observedCutoffs };
    }],
    when: ["selecting, receipting, and selecting the unchanged journal again", async (fx) => {
      const dependencies = {
        receipts: fx.receipts,
        getMtime: () => Date.parse(fx.newCursor),
        getLivePanes: async () => [{ index: 0, command: "claude" }],
        getStatus: async () => "idle",
        getContext: () => ({ percent: 35 }),
        getTurns: (_dir, cutoff) => {
          fx.observedCutoffs.push(cutoff.toISOString());
          return cutoff.toISOString() === fx.oldCursor
            ? { count: 10, latest: fx.newCursor }
            : { count: 0, latest: null };
        },
      };
      const first = await collectDreamTargets({}, fx.agents, Date.parse("2026-07-20T00:00:00Z"), dependencies);
      const nextState = recordDreamReceipt(fx.receipts, first.targets[0], {
        path: fx.receiptPath,
        dateKey: "2026-07-21",
        now: new Date("2026-07-21T10:30:00Z"),
      });
      const second = await collectDreamTargets({}, fx.agents, Date.parse("2026-07-20T00:00:00Z"), {
        ...dependencies,
        receipts: nextState,
      });
      return { fx, first, second, stored: readDreamReceipts(fx.receiptPath) };
    }],
    then: ["the second night has no target until ten newer turns exist", ({ fx, first, second, stored }) => {
      expect(first.targets).toHaveLength(1);
      expect(first.targets[0]).toMatchObject({ turns: 10, compact: false, activityCursor: fx.newCursor });
      expect(fx.observedCutoffs).toEqual([fx.oldCursor, fx.newCursor]);
      expect(second.targets).toEqual([]);
      expect(second.ineligible).toHaveLength(1);
      expect(stored.panes["ai:0"]).toMatchObject({
        activityCursor: fx.newCursor,
        dreamedAt: "2026-07-21T10:30:00.000Z",
        summarizedTurns: 10,
      });
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });

  unit("corrupt receipt state fails closed instead of waking panes again", {
    given: ["an invalid receipt file", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-dream-corrupt-"));
      const path = join(root, "state.json");
      writeFileSync(path, "{broken");
      return { root, path };
    }],
    when: ["reading it", ({ path }) => {
      try { readDreamReceipts(path); return null; }
      catch (error) { return error; }
    }],
    then: ["the exact state error is reported", (error, { root }) => {
      expect(error?.message).toContain("dream receipt state is unreadable");
      rmSync(root, { recursive: true, force: true });
    }],
  });

  unit("a missing receipt store bootstraps as empty", {
    when: ["reading a missing file", () => readDreamReceipts(join(tmpdir(), `missing-${Date.now()}.json`))],
    then: ["schema v1 has no panes", (state) => expect(state).toEqual(emptyDreamReceipts())],
  });
});
