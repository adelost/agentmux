import { component, expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdDream } from "../cli/dream.mjs";
import { readDreamOwnerResult, writeDreamOwnerInput } from "../core/dream-owner.mjs";
import { finishDreamMemoryRepairs } from "../core/dream-memory-repairs.mjs";

const now = new Date("2026-10-16T00:00:00Z");
const owner = { agent: "sandman", pane: 1, engine: "codex", paneDir: "/isolated/curator" };
const prefix = "> summary: Test memory.\n> why: An isolated controller proof.\n";

function fixture(file = "memory/references/source.md", text = "# Source\n- Verified fact.\n") {
  const root = mkdtempSync(join(tmpdir(), "dream-repair-"));
  mkdirSync(join(root, "memory", "references"), { recursive: true });
  writeFileSync(join(root, "MEMORY.md"), prefix);
  writeFileSync(join(root, file), text);
  const home = process.env.HOME, janitor = process.env.AMUX_JANITOR_ENABLED, source = process.env.AMUX_DREAM_SOURCE;
  // Log-only nights no longer curate handwritten reference warnings; retain explicit legacy-mode repair proof.
  process.env.AMUX_DREAM_SOURCE = "raw";
  process.env.HOME = root; process.env.AMUX_JANITOR_ENABLED = "false";
  const fx = { root, file, original: text, sends: 0, document: null };
  fx.deps = {
    now, owner, agents: [], receiptPath: join(root, "receipts.json"),
    readReceipts: () => ({ schemaVersion: 1, panes: {} }),
    collectSources: () => ({ sources: [], unreadable: [], skipped: [] }),
    notifyUser: async () => ({ sent: false, outcome: "not-sent" }),
    getStatus: async () => "idle", getProof: async () => ({ ownerTexts: [] }),
    enterSandbox: async (_ctx, _owner, input) => ({ ...input.sandbox, runId: input.runId, inputSha256: input.sha256, sessionId: "session-1", status: "running", kernelVerified: true }),
    finishSandbox: () => {},
    getContext: () => ({ model: "gpt-6.1-sol", effort: "xhigh" }),
    compactCodex: async () => ({ ok: true, sessionId: "session-1", compactBoundary: true }),
    writeInput: document => { fx.document = document; fx.input = writeDreamOwnerInput(document, { rootDir: join(root, "input") }); return fx.input; },
    mirrorPrompt: async () => ({}), send: async () => { fx.sends++; return { delivered: true }; },
    nightlyCompact: async () => {}, recordReceipts: () => {},
  };
  fx.run = () => cmdDream({ configPath: "unused", agent: { ensureReady: async () => {} } }, { workspace: root, quiet: true }, fx.deps);
  fx.cleanup = () => {
    if (home === undefined) delete process.env.HOME; else process.env.HOME = home;
    if (janitor === undefined) delete process.env.AMUX_JANITOR_ENABLED; else process.env.AMUX_JANITOR_ENABLED = janitor;
    if (source === undefined) delete process.env.AMUX_DREAM_SOURCE; else process.env.AMUX_DREAM_SOURCE = source;
    rmSync(root, { recursive: true, force: true });
  };
  return fx;
}

function scriptedResult(fx, edit) {
  fx.deps.waitForResult = async ({ outputPath, dateKey, runId, sourceSha256 }) => {
    const warning = fx.document.payload.memoryRepair.warnings.find(row => row.file === fx.file);
    const repairs = edit ? [{ warningId: warning.id, ...edit }] : [];
    writeFileSync(outputPath, [
      `> Kuraterad av sandman:1 efter verifierad kompaktering · run \`${runId}\` · source \`${sourceSha256}\`.`,
      "- Minneskontrollen granskades.", "```amux-memory-repairs", JSON.stringify({ version: 1, repairs }), "```", "",
    ].join("\n"));
    return readDreamOwnerResult(outputPath, dateKey, runId, owner, sourceSha256);
  };
}

feature("Dream gives memory warnings an actor without giving the model write authority", () => {
  component("a log-derived night does not launch repair-only work from handwritten references", {
    given: ["a reference warning but no conversation activity", () => fixture()],
    when: ["running the default log source", async fx => {
      process.env.AMUX_DREAM_SOURCE = "conversation-log";
      await fx.run(); return fx;
    }],
    then: ["no extra model turn or reference edit", fx => {
      expect(fx.sends).toBe(0);
      expect(readFileSync(join(fx.root, fx.file), "utf8")).toBe(fx.original);
    }], cleanup: fx => fx.cleanup(),
  });
  component("recovery reuses the normalized repair product instead of applying or appending again", {
    given: ["a warning with a safe scripted repair", () => fixture()],
    when: ["finishing and then recovering the same isolated product", async fx => {
      scriptedResult(fx, { before: "# Source\n", after: `${prefix}# Source\n` });
      await fx.run();
      const before = readFileSync(fx.input.outputPath, "utf8");
      const product = readDreamOwnerResult(fx.input.outputPath, fx.document.dateKey, fx.input.runId, owner, fx.input.sha256);
      finishDreamMemoryRepairs({ workspace: fx.root, input: fx.input, product });
      return { fx, before, after: readFileSync(fx.input.outputPath, "utf8") };
    }],
    then: ["the saved human result remains byte-identical with one model send", ({ fx, before, after }) => {
      expect(after).toBe(before); expect(fx.sends).toBe(1);
    }], cleanup: fx => fx.cleanup(),
  });
  component("a scripted curator repairs missing metadata even without new fleet activity", {
    given: ["one reference missing its summary", () => fixture()],
    when: ["running the real controller with one scripted model response", async fx => {
      scriptedResult(fx, { before: "# Source\n", after: `${prefix}# Source\n` });
      await fx.run(); return fx;
    }],
    then: ["the controller fixes the warning, preserves facts and uses one turn", fx => {
      expect(readFileSync(join(fx.root, fx.file), "utf8")).toBe(`${prefix}${fx.original}`);
      expect(fx.sends).toBe(1);
    }], cleanup: fx => fx.cleanup(),
  });
  component("a clean memory and no new work never starts a curator", {
    given: ["a clean workspace with only informational findings", () => fixture("memory/references/source.md", `${prefix}# Source\n- Verified fact.\n`)],
    when: ["running without activity", async fx => { await fx.run(); return fx; }],
    then: ["no extra model turn was spent", fx => expect(fx.sends).toBe(0)],
    cleanup: fx => fx.cleanup(),
  });
  component("a known broken link can be rebound without changing its factual prose", {
    given: ["a reported broken reference and its existing replacement", () => {
      const fx = fixture("memory/references/source.md", `${prefix}# Source\nSee \`memory/references/missing.md\`.\n`);
      writeFileSync(join(fx.root, "memory/references/found.md"), `${prefix}# Found\n`); return fx;
    }],
    when: ["applying the scripted in-place link correction", async fx => {
      scriptedResult(fx, { before: "See `memory/references/missing.md`.", after: "See `memory/references/found.md`." });
      await fx.run(); return fx;
    }],
    then: ["only the broken reference changes", fx => {
      expect(readFileSync(join(fx.root, fx.file), "utf8")).toBe(fx.original.replace("missing.md", "found.md"));
    }], cleanup: fx => fx.cleanup(),
  });
  component("an edit that trades summary_missing for why_missing is never written", {
    given: ["a reference missing its metadata", () => fixture()],
    when: ["proposing a partial correction that creates another warning", async fx => {
      scriptedResult(fx, { before: "# Source\n", after: "> summary: Missing why.\n# Source\n" });
      await fx.run(); return fx;
    }],
    then: ["the rejected candidate leaves the source byte-identical", fx => {
      expect(fx.sends).toBe(1); expect(readFileSync(join(fx.root, fx.file), "utf8")).toBe(fx.original);
    }], cleanup: fx => fx.cleanup(),
  });
  component("a manual edit during curation is never overwritten by the old proposal", {
    given: ["a warning target with a concurrent human writer", () => fixture()],
    when: ["receiving the old model proposal after the file changed", async fx => {
      scriptedResult(fx, { before: "# Source\n", after: `${prefix}# Source\n` });
      const result = fx.deps.waitForResult;
      fx.deps.waitForResult = async args => {
        writeFileSync(join(fx.root, fx.file), fx.original + "- A newer verified fact.\n");
        return result(args);
      };
      await fx.run(); return fx;
    }],
    then: ["the newer authored bytes survive", fx => {
      expect(readFileSync(join(fx.root, fx.file), "utf8")).toBe(fx.original + "- A newer verified fact.\n");
    }], cleanup: fx => fx.cleanup(),
  });
  component("a proposed repair cannot discard a fact to clear its warning", {
    given: ["one reference with a fact", () => fixture()],
    when: ["proposing metadata plus a silent factual deletion", async fx => {
      scriptedResult(fx, { before: fx.original, after: `${prefix}# Source\n` });
      await fx.run(); return fx;
    }],
    then: ["the fact file stays byte-identical and Dream asks rather than hiding the rejected repair", fx => {
      expect(readFileSync(join(fx.root, fx.file), "utf8")).toBe(fx.original);
      expect(fx.sends).toBe(1);
      expect(readFileSync(join(fx.root, "memory", "2026-10-16.md"), "utf8")).toContain("amux-dream-summary");
      const result = readFileSync(fx.input.outputPath, "utf8");
      expect(result).toContain("Frågor till Mattias");
    }], cleanup: fx => fx.cleanup(),
  });
  component("a curator repair in a daily file is refused", {
    given: ["an old daily file that lint reports", () => fixture("memory/2026-10-01.md", "- Original daily fact.\n")],
    when: ["proposing a metadata repair in that protected file", async fx => {
      scriptedResult(fx, { before: fx.original, after: `${prefix}${fx.original}` });
      await fx.run(); return fx;
    }],
    then: ["no old daily bytes are rewritten by the repair path", fx => {
      expect(fx.sends).toBe(1);
      expect(readFileSync(join(fx.root, fx.file), "utf8")).toBe(fx.original);
    }], cleanup: fx => fx.cleanup(),
  });
  component("Isabella's missing lesson becomes a question, not invented memory", {
    given: ["a real-shaped people entry with no known lesson", () => fixture("memory/people.md",
      `${prefix}\n## People <!-- entry-check: lärdom -->\n**Isabella (Wahlund Hansson)** ${String.fromCodePoint(8212)} known facts\n- Verified meeting.\n`)],
    when: ["curating without a factual lesson", async fx => {
      scriptedResult(fx); await fx.run(); return fx;
    }],
    then: ["the people file is unchanged and the immutable summary contains the explicit question", fx => {
      expect(fx.sends).toBe(1);
      expect(readFileSync(join(fx.root, fx.file), "utf8")).toBe(fx.original);
      const daily = readFileSync(join(fx.root, "memory", "2026-10-16.md"), "utf8");
      const path = daily.match(/\]\((dream\/[^)]+\.md)\)/u)?.[1];
      expect(readFileSync(join(fx.root, "memory", path), "utf8")).toContain("Vilken lärdom vill Mattias spara för Isabella");
    }], cleanup: fx => fx.cleanup(),
  });
  component("a dispatched curator refusal never buys a second turn from its fallback", {
    given: ["two configured candidates and one active source", () => fixture()],
    when: ["the first curator returns a quota refusal after dispatch", async fx => {
      fx.deps.candidates = [owner, { ...owner, pane: 2 }]; delete fx.deps.owner;
      fx.deps.collectSources = () => ({ sources: [{ agent: "work", pane: 0, engine: "codex", turns: 1,
        activityCursor: "2026-10-15T22:00:00Z", latestMs: Date.parse("2026-10-15T22:00:00Z"), filesOmitted: 0,
        entries: [{ timestamp: "2026-10-15T22:00:00Z", userPrompt: "finish the repair", items: [{ type: "text", content: "checkpoint" }] }],
      }], unreadable: [], skipped: [] });
      fx.deps.waitForResult = async () => ({ ok: false, reason: "dream-owner-limited" });
      try { await fx.run(); } catch (error) { fx.error = error; }
      return fx;
    }],
    then: ["the failure is honest and exactly one curator was sent work", fx => {
      expect(fx.error?.message).toContain("dream-owner-product-invalid:dream-owner-limited");
      expect(fx.sends).toBe(1);
    }], cleanup: fx => fx.cleanup(),
  });
});
