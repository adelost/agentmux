import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdCompact } from "./compact.mjs";
import { createSelfCompactStore } from "../core/self-compact.mjs";
import { vi } from "vitest";

vi.mock("./tmux.mjs", () => ({ hasSession: async () => true,
  listPanes: async () => [{ index: 4, command: "codex" }], sendToPane: async () => ({ delivered: true }) }));
vi.mock("./inspect-pane.mjs", () => ({ dialectFor: () => "codex",
  inspectPane: async () => ({ status: "working", context: { tokens: 301_300, percent: 36 } }) }));

feature("an agent compacts its own checkpoint, not its active composer", () => {
  component("the actual lsrc:4 targeted force command is a safe deferred request with an exact handoff", {
    given: ["the calling pane lsrc:4 and a clean saved checkpoint", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-self-cli-")), path = join(root, "rollout.jsonl");
      const configPath = join(root, "agents.yaml"), handoff = "Read checkpoint 87530dea. Fortsätt med bytes. No deploy/provider.";
      writeFileSync(path, ""); writeFileSync(configPath, `lsrc:\n  dir: ${root}\n  panes:\n${"    - cmd: codex\n".repeat(5)}`);
      const store = createSelfCompactStore({ dir: join(root, "requests") });
      const ctx = { configPath, agent: { sendOnly: () => { throw new Error("must not touch the active composer"); } } };
      const options = { detect: () => ({ session: "lsrc", pane: 4, key: "lsrc:4" }), store,
        readContext: async () => ({ tokens: 301_300 }), lastCompactAt: () => null,
        identityFor: () => ({ sessionId: "session", path }) };
      return { root, path, store, ctx, options, handoff };
    }],
    when: ["the agent calls its old targeted --force -m spelling", fx => cmdCompact(fx.ctx, { p: 4, force: true, m: fx.handoff }, ["lsrc"], fx.options)],
    then: ["a deferred self request saves exact handoff bytes without typing /compact prose mid-turn", (_, fx) => {
      expect(fx.store.read("lsrc", 4)).toMatchObject({ focus: fx.handoff, continuation: fx.handoff,
        identity: { sessionId: "session", path: fx.path, engine: "codex" } });
    }], cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
});
