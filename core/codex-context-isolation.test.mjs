import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { getContextPercent, resetCodexSessionIndexForTests } from "./context.mjs";

function fixture(withPane = true) {
  const root = mkdtempSync(join(tmpdir(), "amux-context-isolation-"));
  const key1 = "AMUX_CODEX_PROFILE_1_HOME", key2 = "AMUX_CODEX_PROFILE_2_HOME";
  const prior = [process.env[key1], process.env[key2]];
  process.env[key1] = root;
  process.env[key2] = join(root, "unused");
  const sessions = join(root, "sessions");
  mkdirSync(sessions);
  const pane = "/workspace/.agents/4";
  const record = (name, cwd, model, tokens, compactAt) => {
    const path = join(sessions, `${name}.jsonl`);
    const events = [
      { type: "session_meta", payload: { cwd } },
      { type: "turn_context", payload: { model, effort: "xhigh" } },
      { type: "event_msg", payload: { type: "token_count", info: { last_token_usage: { total_tokens: tokens }, model_context_window: 800_000 } } },
      ...(compactAt ? [{ type: "compacted", timestamp: compactAt }] : []),
    ];
    writeFileSync(path, events.map(JSON.stringify).join("\n") + "\n");
    return path;
  };
  if (withPane) record("pane", pane, "gpt-5.6-sol", 12_000, null);
  const parent = record("parent", "/workspace", "gpt-6-astra", 181_000, "2026-09-20T12:42:00Z");
  utimesSync(parent, new Date(), new Date(Date.now() + 10_000));
  resetCodexSessionIndexForTests();
  return { pane, cleanup() {
    for (const [i, key] of [key1, key2].entries()) {
      if (prior[i] === undefined) delete process.env[key]; else process.env[key] = prior[i];
    }
    resetCodexSessionIndexForTests();
    rmSync(root, { recursive: true, force: true });
  } };
}

feature("Codex model and compact evidence belongs to its exact pane", () => {
  component("a newer parent conversation cannot replace Sol or supply a compact receipt", {
    given: ["a Sol pane under a newer Astra conversation", () => fixture()],
    when: ["reading the panel used by Discord and model switching", ({ pane }) => getContextPercent(pane, "codex")],
    then: ["model, token count and compact receipt all belong to the pane", (value, ctx) => {
      try { expect(value).toMatchObject({ model: "gpt-5.6-sol", tokens: 12_000, lastCompactAt: null }); }
      finally { ctx.cleanup(); }
    }],
  });
  component("an unobserved pane never borrows its parent's model", {
    given: ["only the parent conversation exists", () => fixture(false)],
    when: ["reading the child pane", ({ pane }) => getContextPercent(pane, "codex")],
    then: ["model evidence remains unknown", (value, ctx) => {
      try { expect(value).toBeNull(); } finally { ctx.cleanup(); }
    }],
  });
});
