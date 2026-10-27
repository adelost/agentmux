import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { isBusyFromCodexJsonl } from "./codex-jsonl-reader.mjs";

// More panes than the 8-file event cache holds, as in the live fleet (32 Codex panes).
const PANES = Array.from({ length: 9 }, (_, index) => `/workspace/.agents/${index}`);
// Whole seconds round-trip exactly through utimes, so the rollout keeps its stamp.
const WRITTEN_AT = new Date("2026-10-27T20:00:00Z");

function fleet() {
  const root = mkdtempSync(join(tmpdir(), "amux-codex-busy-"));
  const key1 = "AMUX_CODEX_PROFILE_1_HOME", key2 = "AMUX_CODEX_PROFILE_2_HOME";
  const prior = [process.env[key1], process.env[key2]];
  process.env[key1] = root;
  process.env[key2] = join(root, "unused");
  mkdirSync(join(root, "sessions"));
  const rollouts = PANES.map((cwd, index) => {
    const path = join(root, "sessions", `rollout-${index}.jsonl`);
    writeFileSync(path, [
      { type: "session_meta", payload: { id: `019f0000-0000-7000-8000-00000000000${index}`, cwd, source: "cli", originator: "codex-tui" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "T" } },
    ].map(JSON.stringify).join("\n") + "\n");
    utimesSync(path, WRITTEN_AT, WRITTEN_AT);
    return path;
  });
  return { rollouts, cleanup() {
    for (const [i, key] of [key1, key2].entries()) {
      if (prior[i] === undefined) delete process.env[key]; else process.env[key] = prior[i];
    }
    rmSync(root, { recursive: true, force: true });
  } };
}

// Same length, same mtime: only a re-read of the rollout can see the turn end.
function endTurnKeepingStamp(rollout) {
  writeFileSync(rollout, readFileSync(rollout, "utf8").replace("task_started", "task_stopped"));
  utimesSync(rollout, WRITTEN_AT, WRITTEN_AT);
}

feature("Codex busy checks across the fleet", () => {
  // defect: the credit guard re-read an 8 MB tail per Codex pane every 10 s, 20 % of the bridge CPU (2026-10-27).
  component("an unchanged rollout keeps its verdict after every pane was polled", {
    given: ["nine busy panes polled once in turn", () => {
      const ctx = fleet();
      for (const pane of PANES) isBusyFromCodexJsonl(pane);
      endTurnKeepingStamp(ctx.rollouts[0]);
      return ctx;
    }],
    when: ["the first pane is polled again", () => isBusyFromCodexJsonl(PANES[0])],
    then: ["its verdict comes from the unchanged stamp", (busy, ctx) => {
      try { expect(busy).toBe(true); } finally { ctx.cleanup(); }
    }],
  });
});
