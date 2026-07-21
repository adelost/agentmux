import { feature, component, expect } from "bdd-vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { cmdDream } from "../cli/commands.mjs";

function activeSource() {
  return {
    agent: "lsrc", pane: 3, engine: "codex", turns: 2,
    activityCursor: "2026-07-21T10:00:00Z",
    latestMs: Date.parse("2026-07-21T10:00:00Z"), filesOmitted: 0,
    entries: [{
      timestamp: "2026-07-21T10:00:00Z", userPrompt: "implementera fixen",
      items: [{ type: "text", content: "PR merged and verified" }],
    }],
  };
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amux-dream-command-"));
  const previousHome = process.env.HOME;
  const previousJanitor = process.env.AMUX_JANITOR_ENABLED;
  process.env.HOME = root;
  process.env.AMUX_JANITOR_ENABLED = "false";
  return {
    root, previousHome, previousJanitor,
    workspace: join(root, "workspace"), receiptPath: join(root, "receipts.json"),
    receipts: { schemaVersion: 1, panes: {} },
  };
}

function cleanup(fx) {
  process.env.HOME = fx.previousHome;
  if (fx.previousJanitor === undefined) delete process.env.AMUX_JANITOR_ENABLED;
  else process.env.AMUX_JANITOR_ENABLED = fx.previousJanitor;
  rmSync(fx.root, { recursive: true, force: true });
}

feature("amux dream stateless orchestration", () => {
  component("dry-run measures the real batch without invoking a model or writing", {
    given: ["one active source", () => fixture()],
    when: ["previewing", async (fx) => {
      let modelCalls = 0;
      const result = await cmdDream({ configPath: "unused" }, {
        dry: true, workspace: fx.workspace,
      }, {
        agents: [], receiptPath: fx.receiptPath,
        readReceipts: () => fx.receipts,
        collectSources: () => ({ sources: [activeSource()], unreadable: [] }),
        summarize: async () => { modelCalls++; return "must not run"; },
      });
      return { fx, result, modelCalls };
    }],
    then: ["there is one batch and no mutation", ({ fx, result, modelCalls }) => {
      expect(modelCalls).toBe(0);
      expect(result.included).toHaveLength(1);
      expect(existsSync(fx.receiptPath)).toBe(false);
      expect(existsSync(fx.workspace)).toBe(false);
      cleanup(fx);
    }],
  });

  component("one successful model call writes one block before one batch receipt", {
    given: ["one active source", () => fixture()],
    when: ["running Dream", async (fx) => {
      const events = [];
      const result = await cmdDream({ configPath: "unused" }, {
        workspace: fx.workspace, quiet: true, deferSentinel: true,
      }, {
        now: new Date("2026-07-21T12:00:00Z"), agents: [], receiptPath: fx.receiptPath,
        readReceipts: () => fx.receipts,
        collectSources: () => ({ sources: [activeSource()], unreadable: [] }),
        summarize: async () => { events.push("model"); return "- Fixen mergades och verifierades."; },
        recordReceipts: (_state, targets) => {
          events.push(`receipt:${targets.length}`);
          const path = join(fx.workspace, "memory", "2026-07-21.md");
          expect(readFileSync(path, "utf8")).toContain("Fixen mergades");
        },
      });
      return { fx, result, events };
    }],
    then: ["the model runs once and receipt follows the durable memory product", ({ fx, result, events }) => {
      expect(events).toEqual(["model", "receipt:1"]);
      expect(result.included).toHaveLength(1);
      const memory = readFileSync(result.path, "utf8");
      expect(memory.match(/amux-dream-summary:2026-07-21/g)).toHaveLength(2);
      cleanup(fx);
    }],
  });

  component("a failed or invalid summary never advances receipts", {
    given: ["one active source", () => fixture()],
    when: ["the model returns a reserved marker", async (fx) => {
      let receiptCalls = 0;
      let error = null;
      try {
        await cmdDream({ configPath: "unused" }, { workspace: fx.workspace }, {
          now: new Date("2026-07-21T12:00:00Z"), agents: [], receiptPath: fx.receiptPath,
          readReceipts: () => fx.receipts,
          collectSources: () => ({ sources: [activeSource()], unreadable: [] }),
          summarize: async () => "<!-- amux-bad -->",
          recordReceipts: () => { receiptCalls++; },
        });
      } catch (caught) { error = caught; }
      return { fx, error, receiptCalls };
    }],
    then: ["the exact validation failure is visible and nothing is receipted", ({ fx, error, receiptCalls }) => {
      expect(error?.message).toContain("reserved-marker");
      expect(receiptCalls).toBe(0);
      cleanup(fx);
    }],
  });
});
