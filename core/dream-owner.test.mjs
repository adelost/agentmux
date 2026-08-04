import { expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dreamOwnerPrompt, readDreamOwnerQuality, readDreamOwnerResult, resolveDreamCandidates,
  resolveDreamOwner, writeDreamOwnerInput,
} from "./dream-owner.mjs";

const FLEET = {
  claw: { dir: "/workspace", panes: [
    { cmd: "claude" }, { cmd: "claude" }, { cmd: "claude" }, { cmd: "codex --yolo" },
  ] },
};

feature("Dream candidate list", () => {
  unit("without candidates the configured owner remains the only curator", {
    when: ["resolving a config that predates the candidate list", () =>
      resolveDreamCandidates({ dream: { agent: "claw", pane: 3 }, ...FLEET })],
    then: ["exactly the configured pane, unchanged", (owners) => {
      expect(owners).toHaveLength(1);
      expect(owners[0]).toMatchObject({ agent: "claw", pane: 3, engine: "codex" });
    }],
  });

  unit("candidates are ordered, deduplicated, and accept both ref forms", {
    when: ["resolving a list that repeats the primary", () =>
      resolveDreamCandidates({
        dream: { agent: "claw", pane: 1, candidates: ["claw:1", "claw:2", { agent: "claw", pane: 3 }] },
        ...FLEET,
      })],
    then: ["the primary leads and never appears twice", (owners) => {
      expect(owners.map((owner) => `${owner.agent}:${owner.pane}`)).toEqual(["claw:1", "claw:2", "claw:3"]);
    }],
  });

  unit("a malformed candidate fails loudly instead of quietly shrinking the list", {
    when: ["resolving a typo and a non-list", () => ({
      typo: (() => {
        try {
          resolveDreamCandidates({ dream: { agent: "claw", pane: 1, candidates: ["claw:99"] }, ...FLEET });
          return null;
        } catch (error) { return error.message; }
      })(),
      notAList: (() => {
        try {
          resolveDreamCandidates({ dream: { agent: "claw", pane: 1, candidates: "claw:2" }, ...FLEET });
          return null;
        } catch (error) { return error.message; }
      })(),
    })],
    then: ["both name the exact problem", ({ typo, notAList }) => {
      expect(typo).toContain("dream-candidate-not-configured");
      expect(typo).toContain("claw:99");
      expect(notAList).toContain("dream-candidates-invalid");
    }],
  });
});

feature("configured Dream owner", () => {
  unit("resolves one existing Codex pane and rejects hidden fallback", {
    when: ["reading generated fleet config", () => ({
      selected: resolveDreamOwner({
        dream: { agent: "claw", pane: 3 },
        claw: { dir: "/workspace", panes: [
          { cmd: "claude" }, { cmd: "claude" }, { cmd: "claude" }, { cmd: "codex --yolo" },
        ] },
      }),
      missing: (() => { try { resolveDreamOwner({}); return null; } catch (error) { return error.message; } })(),
    })],
    then: ["the address and dialect are explicit", ({ selected, missing }) => {
      expect(selected).toMatchObject({
        agent: "claw", pane: 3, engine: "codex", paneDir: "/workspace/.agents/3",
      });
      expect(missing).toContain("dream-owner-not-configured");
    }],
  });

  unit("banks exact local input and exposes the full memory-edit brief", {
    given: ["one temporary operator store", () => mkdtempSync(join(tmpdir(), "amux-dream-owner-"))],
    when: ["writing input and building the prompt", (root) => {
      const input = writeDreamOwnerInput({ dateKey: "2026-08-01", payload: { panes: [] } }, {
        rootDir: root, runId: "run-1",
      });
      const prompt = dreamOwnerPrompt({
        owner: { agent: "claw", pane: 3, engine: "codex" }, input,
        memPath: "/memory/2026-08-01.md", previousMemPath: "/memory/2026-07-31.md",
        dateKey: "2026-08-01", included: 16, omitted: 0, unreadable: 0,
      });
      return { root, input, prompt };
    }],
    then: ["the source is durable and the visible task names owner, hash, and exact output", ({ root, input, prompt }) => {
      expect(JSON.parse(readFileSync(input.path, "utf8")).dateKey).toBe("2026-08-01");
      expect(prompt).toContain("Dream-kuratorn claw:3");
      expect(prompt).toContain(input.sha256);
      expect(prompt).toContain(input.outputPath);
      expect(prompt).toContain("Ändra INTE någon minnesfil");
      expect(prompt).toContain("DREAM_OK 2026-08-01 run-1");
      rmSync(root, { recursive: true, force: true });
    }],
  });

  unit("reads Codex model and effort only from the exact pane-owned rollout", {
    when: ["observing one exact identity", () => readDreamOwnerQuality({
      agent: "claw", pane: 3, engine: "codex", paneDir: "/workspace/.agents/3",
    }, {
      latestCodexIdentity: () => ({ sessionId: "session-exact", path: "/exact/rollout.jsonl" }),
      readCodexLines: (path) => [
        JSON.stringify({ type: "turn_context", payload: { model: "gpt-old", effort: "medium" } }),
        JSON.stringify({
          type: "turn_context",
          payload: {
            model: "gpt-5.6-sol",
            collaboration_mode: { settings: { reasoning_effort: "max" } },
          },
        }),
        JSON.stringify({ type: "event_msg", payload: { type: "task_complete" } }),
        path,
      ],
    })],
    then: ["quality carries the same immutable session and file identity", (quality) => {
      expect(quality).toMatchObject({
        model: "gpt-5.6-sol", effort: "max", sessionId: "session-exact",
        source: "codex-turn-context", sourcePath: "/exact/rollout.jsonl",
      });
    }],
  });

  unit("accepts only the current run's bounded marker block", {
    given: ["one daily file", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-dream-result-"));
      const path = join(root, "2026-08-01.summary.md");
      writeFileSync(path, [
        "> Kuraterad av claw:3 efter verifierad kompaktering · run `run-2` · source `source-2`.",
        "- Viktigt beslut.", "",
      ].join("\n"));
      return { root, path };
    }],
    when: ["checking current and stale run ids", ({ path }) => ({
      current: readDreamOwnerResult(path, "2026-08-01", "run-2", { agent: "claw", pane: 3 }, "source-2"),
      stale: readDreamOwnerResult(path, "2026-08-01", "run-1", { agent: "claw", pane: 3 }, "source-2"),
    })],
    then: ["only the current run is receiptable", ({ current, stale }, fx) => {
      expect(current.ok).toBe(true);
      expect(stale.reason).toBe("dream-run-receipt-missing");
      rmSync(fx.root, { recursive: true, force: true });
    }],
  });
});
