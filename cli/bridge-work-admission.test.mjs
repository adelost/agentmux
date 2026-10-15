import { feature, component, expect } from "bdd-vitest";
import { createBridgeWorkAdmission } from "./bridge-work-admission.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

feature("bridge work admission wiring", () => {
  component("the extracted notifier remains available to pause compaction", {
    given: ["the actual shared factory and one configured Discord channel", () => {
      const root = mkdtempSync(join(tmpdir(), "bridge-admission-")), configPath = join(root, "agents.yaml"), sent = [];
      writeFileSync(configPath, "test:\n  dir: /work\n  panes:\n    - cmd: codex\n  discord:\n    \"channel\": 0\n");
      return { root, sent, admission: createBridgeWorkAdmission({ agent: {}, state: {}, queue: {}, configPath,
        discord: { send: async (...args) => sent.push(args) } }) };
    }],
    when: ["the pause consumer sends its notification through the shared factory", async fx => {
      await fx.admission.notify("test", 0, "compact verified"); return fx.sent;
    }],
    then: ["the original configured notice sink receives it once", sent => expect(sent).toEqual([["channel", "compact verified", { kind: "notice" }]])],
    cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
});
