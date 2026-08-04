import { feature, component, expect } from "bdd-vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
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

const owner = {
  agent: "claw", pane: 3, engine: "codex", paneDir: "/workspace/.agents/3",
};

function ownerDependencies(fx, events = []) {
  return {
    now: new Date("2026-07-21T12:00:00Z"),
    agents: [],
    owner,
    receiptPath: fx.receiptPath,
    readReceipts: () => fx.receipts,
    collectSources: () => ({ sources: [activeSource()], unreadable: [], skipped: [] }),
    getStatus: async () => "idle",
    getContext: () => ({ model: "gpt-5.6-sol", effort: "max" }),
    compactCodex: async () => {
      events.push("compact");
      return { ok: true, sessionId: "session-1", compactBoundary: true };
    },
    writeInput: () => ({
      path: "/tmp/dream-input.json", outputPath: "/tmp/dream-output.md",
      runId: "run-1", sha256: "a".repeat(64), bytes: 100,
    }),
    mirrorPrompt: async () => {
      events.push("mirror");
      return { channelId: "channel-3", messages: 1 };
    },
    send: async (_ctx, agent, pane, prompt) => {
      events.push(`send:${agent}:${pane}`);
      expect(prompt).toContain("Du är den uttryckligen konfigurerade Dream-kuratorn claw:3");
      return { delivered: true, pending: false, unverified: false };
    },
  };
}

function cleanup(fx) {
  process.env.HOME = fx.previousHome;
  if (fx.previousJanitor === undefined) delete process.env.AMUX_JANITOR_ENABLED;
  else process.env.AMUX_JANITOR_ENABLED = fx.previousJanitor;
  rmSync(fx.root, { recursive: true, force: true });
}

feature("amux dream configured-pane orchestration", () => {
  component("dry-run measures the real batch without compacting, sending, or writing", {
    given: ["one active source", () => fixture()],
    when: ["previewing", async (fx) => {
      const result = await cmdDream({ configPath: "unused", agent: { ensureReady: async () => {} } }, {
        dry: true, workspace: fx.workspace,
      }, {
        agents: [], owner, receiptPath: fx.receiptPath,
        readReceipts: () => fx.receipts,
        collectSources: () => ({ sources: [activeSource()], unreadable: [], skipped: [] }),
      });
      return { fx, result };
    }],
    then: ["there is one batch and no mutation", ({ fx, result }) => {
      expect(result.included).toHaveLength(1);
      expect(existsSync(fx.receiptPath)).toBe(false);
      expect(existsSync(fx.workspace)).toBe(false);
      cleanup(fx);
    }],
  });

  component("verified compact and visible pane prompt precede one batch receipt", {
    given: ["one active source", () => fixture()],
    when: ["running Dream", async (fx) => {
      const events = [];
      const deps = ownerDependencies(fx, events);
      const result = await cmdDream({ configPath: "unused", agent: { ensureReady: async () => {} } }, {
        workspace: fx.workspace, quiet: true, deferSentinel: true,
      }, {
        ...deps,
        waitForResult: async ({ outputPath, dateKey, runId }) => {
          events.push("product");
          const content = [
            `> Kuraterad av claw:3 efter verifierad kompaktering · run \`${runId}\` · source \`${"a".repeat(64)}\`.`,
            "- Fixen mergades och verifierades.", "",
          ].join("\n");
          writeFileSync(outputPath, content);
          return { ok: true, content, dateKey };
        },
        recordReceipts: (_state, targets) => {
          events.push(`receipt:${targets.length}`);
          const path = join(fx.workspace, "memory", "2026-07-21.md");
          expect(readFileSync(path, "utf8")).toContain("Fixen mergades");
        },
      });
      return { fx, result, events };
    }],
    then: ["the selected pane runs once and receipt follows the durable memory product", ({ fx, result, events }) => {
      expect(events).toEqual(["compact", "mirror", "send:claw:3", "product", "receipt:1"]);
      expect(result.included).toHaveLength(1);
      const memory = readFileSync(result.path, "utf8");
      expect(memory.match(/amux-dream-summary:2026-07-21/g)).toHaveLength(2);
      cleanup(fx);
    }],
  });

  component("--help shows usage with zero writes, sends, locks, or model calls", {
    given: ["a fixture that would otherwise run a full dream", () => fixture()],
    when: ["invoking with the help flag", async (fx) => {
      const calls = { receipts: 0, sources: 0, record: 0 };
      const result = await cmdDream({ configPath: "unused" }, { help: true, workspace: fx.workspace }, {
        agents: new Proxy([], { get: () => { throw new Error("agents must not be read"); } }),
        readReceipts: () => { calls.receipts++; return fx.receipts; },
        collectSources: () => { calls.sources++; return { sources: [], unreadable: [] }; },
        recordReceipts: () => { calls.record++; },
      });
      return { fx, result, calls };
    }],
    then: ["usage only, no side effects of any kind", ({ fx, result, calls }) => {
      expect(result).toEqual({ help: true });
      expect(calls).toEqual({ receipts: 0, sources: 0, record: 0 });
      expect(existsSync(fx.workspace)).toBe(false);
      expect(existsSync(join(fx.root, ".openclaw", ".dream.lock"))).toBe(false);
      cleanup(fx);
    }],
  });

  component("a failed or invalid pane product never advances receipts", {
    given: ["one active source", () => fixture()],
    when: ["the owner fails to produce a valid block", async (fx) => {
      let receiptCalls = 0;
      let error = null;
      try {
        const deps = ownerDependencies(fx);
        await cmdDream({ configPath: "unused", agent: { ensureReady: async () => {} } }, { workspace: fx.workspace }, {
          ...deps,
          waitForResult: async () => ({ ok: false, reason: "reserved-marker" }),
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

  component("a lost night states itself in the daily file instead of passing as a quiet day", {
    given: ["one active source and a quota-dead curator pane", () => fixture()],
    when: ["the configured owner is not idle, exactly as on 2026-08-04", async (fx) => {
      const events = [];
      let error = null;
      let receiptCalls = 0;
      try {
        await cmdDream({ configPath: "unused", agent: { ensureReady: async () => {} } }, {
          workspace: fx.workspace, quiet: true,
        }, {
          ...ownerDependencies(fx, events),
          getStatus: async () => "limited",
          recordReceipts: () => { receiptCalls++; },
        });
      } catch (caught) { error = caught; }
      const dailyPath = join(fx.workspace, "memory", "2026-07-21.md");
      return {
        fx, error, events, receiptCalls,
        daily: existsSync(dailyPath) ? readFileSync(dailyPath, "utf8") : null,
      };
    }],
    then: ["the run still hard-fails, and the gap is durably recorded", ({ fx, error, events, receiptCalls, daily }) => {
      // Unchanged contract: no hidden pane takes over, nothing is receipted.
      expect(error?.message).toBe("dream-owner-not-idle:claw:3");
      expect(events).toEqual([]);
      expect(receiptCalls).toBe(0);
      // The new durable evidence: the night says it is missing, in the file
      // everyone reads, both as a parseable marker and as visible prose.
      expect(daily).toContain("<!-- amux-dream-failed:2026-07-21 ");
      expect(daily).toContain("dream-owner-not-idle:claw:3");
      expect(daily).toContain("DIGEST SAKNAS");
      expect(daily).not.toContain("<!-- amux-dream-run:2026-07-21 ");
      cleanup(fx);
    }],
  });

  component("a second failed night replaces the gap marker instead of stacking one per attempt", {
    given: ["one active source", () => fixture()],
    when: ["dream fails twice for the same day", async (fx) => {
      const run = async () => {
        try {
          await cmdDream({ configPath: "unused", agent: { ensureReady: async () => {} } }, {
            workspace: fx.workspace, quiet: true,
          }, { ...ownerDependencies(fx), getStatus: async () => "limited" });
        } catch {}
      };
      await run();
      await run();
      return { fx, daily: readFileSync(join(fx.workspace, "memory", "2026-07-21.md"), "utf8") };
    }],
    then: ["exactly one marker and one prose line remain", ({ fx, daily }) => {
      expect(daily.match(/<!-- amux-dream-failed:2026-07-21 /g)).toHaveLength(1);
      expect(daily.match(/DIGEST SAKNAS/g)).toHaveLength(1);
      cleanup(fx);
    }],
  });

  component("unknown quality, Haiku, and effort low fail before compact or delivery", {
    given: ["one active source", () => fixture()],
    when: ["the selected pane reports a forbidden runtime", async (fx) => {
      const events = [];
      let error = null;
      try {
        await cmdDream({ configPath: "unused", agent: { ensureReady: async () => {} } }, {
          workspace: fx.workspace,
        }, {
          ...ownerDependencies(fx, events),
          getContext: () => ({ model: "claude-haiku-4-5", effort: "low" }),
        });
      } catch (caught) { error = caught; }
      return { fx, events, error };
    }],
    then: ["the hidden-cheap-quality path is impossible", ({ fx, events, error }) => {
      expect(error?.message).toContain("dream-owner-quality-blocked");
      expect(events).toEqual([]);
      cleanup(fx);
    }],
  });
});
