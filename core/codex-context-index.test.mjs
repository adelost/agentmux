import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getContextPercent, resetCodexSessionIndexForTests } from "./context.mjs";

const PANE = "/workspace/.agents/4";
// Whole seconds round-trip exactly through utimes, so the cache key stays equal.
const WRITTEN_AT = new Date("2026-10-27T20:00:00Z");

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "amux-context-index-"));
  const key1 = "AMUX_CODEX_PROFILE_1_HOME", key2 = "AMUX_CODEX_PROFILE_2_HOME";
  const prior = [process.env[key1], process.env[key2]];
  process.env[key1] = root;
  process.env[key2] = join(root, "unused");
  mkdirSync(join(root, "sessions"));
  const rollout = join(root, "sessions", "pane.jsonl");
  writeFileSync(rollout, [
    { type: "session_meta", payload: { id: "019f0000-0000-7000-8000-000000000004", cwd: PANE } },
    { type: "turn_context", payload: { model: "gpt-5.6-sol", effort: "xhigh" } },
    { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: 12_000 }, model_context_window: 800_000 } } },
  ].map(JSON.stringify).join("\n") + "\n");
  utimesSync(rollout, WRITTEN_AT, WRITTEN_AT);
  resetCodexSessionIndexForTests();
  return { rollout, cleanup() {
    for (const [i, key] of [key1, key2].entries()) {
      if (prior[i] === undefined) delete process.env[key]; else process.env[key] = prior[i];
    }
    resetCodexSessionIndexForTests();
    rmSync(root, { recursive: true, force: true });
  } };
}

// Same length, same mtime: only a re-read of the header can see this.
function rewriteHeaderKeepingMtime(rollout) {
  writeFileSync(rollout, readFileSync(rollout, "utf8").replace(PANE, "/workspace/.agents/9"));
  utimesSync(rollout, WRITTEN_AT, WRITTEN_AT);
}

feature("Codex context index refreshes without re-reading unchanged rollouts", () => {
  // defect: the bridge re-read the 64 KB head of all 563 rollouts every second (37 MB/s), 2026-10-27.
  component("an index refresh reuses the header of a rollout whose mtime did not change", {
    given: ["a pane rollout already read once", () => {
      const ctx = fixture();
      getContextPercent(PANE, "codex");
      rewriteHeaderKeepingMtime(ctx.rollout);
      resetCodexSessionIndexForTests();
      return ctx;
    }],
    when: ["the refreshed index serves the pane again", () => getContextPercent(PANE, "codex")],
    then: ["the pane keeps its session from the cached header", (value, ctx) => {
      try { expect(value).toMatchObject({ tokens: 12_000, model: "gpt-5.6-sol" }); }
      finally { ctx.cleanup(); }
    }],
  });
});
