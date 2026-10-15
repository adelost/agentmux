import { component, expect, feature } from "bdd-vitest";
import { appendFileSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { cmdCompact } from "./compact.mjs";
import { createState } from "../core/state.mjs";
import { rememberContextCompact } from "../core/context-maintenance.mjs";
import { captureJsonlAppendCursor } from "../core/jsonl-append-cursor.mjs";

const sent = [];
const journals = {};
vi.mock("./tmux.mjs", () => ({ hasSession: async () => true,
  listPanes: async () => [{ index: 1, command: "claude" }, { index: 2, command: "claude" }],
  sendToPane: async (_ctx, agent, pane, text) => { sent.push(`${agent}:${pane} ${text}`); return { delivered: true }; } }));
// Claude keeps reporting the pre-compact size until its next turn, so both panes read 107k.
vi.mock("./inspect-pane.mjs", () => ({ dialectFor: () => "claude",
  inspectPane: async () => ({ status: "idle", context: { tokens: 106_838, percent: 10 } }) }));
vi.mock("../core/native-session-identity.mjs", () => ({
  latestPaneSessionIdentity: (_engine, dir) => journals[dir] || null }));

const row = content => `${JSON.stringify({ type: "user", message: { content } })}\n`;

/** Two idle api panes with work; api:2 then gets a verified compact followed by `afterCompact`. */
function fleetWithCompactedPane2(afterCompact) {
  sent.length = 0;
  const root = mkdtempSync(join(tmpdir(), "amux-bulk-fence-"));
  const configPath = join(root, "agents.yaml");
  writeFileSync(configPath, `api:\n  dir: ${root}\n  panes:\n${"    - cmd: claude\n".repeat(3)}`);
  for (const pane of [1, 2]) {
    const path = join(root, `session-${pane}.jsonl`);
    writeFileSync(path, row("Men är det bara disciplin?"));
    journals[join(root, ".agents", String(pane))] = { sessionId: `session-${pane}`, path };
  }
  const state = createState(join(root, "state.json"));
  const pane2 = journals[join(root, ".agents", "2")];
  rememberContextCompact(state, "api", 2, { ok: true, sessionId: pane2.sessionId,
    cursor: captureJsonlAppendCursor("context-maintenance-v1", [pane2.path]) });
  appendFileSync(pane2.path, row(afterCompact));
  return { root, ctx: { configPath, state } };
}

feature("bulk compact skips a context compacted with no work since", () => {
  component("api:2, compacted on 10-11 and idle since, is not compacted again on 10-12", {
    given: ["two idle panes at 107k; api:2's journal has only the /compact after its verified compact",
      () => fleetWithCompactedPane2("/compact")],
    when: ["an operator runs amux compact over the fleet", fx => cmdCompact(fx.ctx, {}, [])],
    then: ["only the pane with uncompacted work gets /compact", () => expect(sent).toEqual(["api:1 /compact"])],
    cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });

  component("new work after the compact makes the pane eligible again", {
    given: ["api:2 compacted, then given a new question", () => fleetWithCompactedPane2("Har han semester?")],
    when: ["an operator runs amux compact over the fleet", fx => cmdCompact(fx.ctx, {}, [])],
    then: ["both panes get /compact", () => expect(sent).toEqual(["api:1 /compact", "api:2 /compact"])],
    cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
});
