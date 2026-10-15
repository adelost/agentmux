import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState } from "./state.mjs";
import { setCodexProfile, setCodexModelOverride, selectedCodexProfile, codexModelOverride } from "./codex-profiles.mjs";

describe("Codex CLI and bridge selections share the existing atomic state boundary", () => {
  it("updates per-pane maps without replacing another writer's entries", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-profile-state-"));
    try {
      const a = createState(join(root, "state.json")), b = createState(join(root, "state.json"));
      const atomic = { get: () => { throw Error("no unlocked read-modify-write"); },
        updateKey: (...args) => a.updateKey(...args) };
      setCodexProfile(atomic, "claw", 5, "2");
      setCodexProfile(b, "lsrc", 9, "2");
      setCodexModelOverride(atomic, "claw", 5, "gpt-6.1-sol", "xhigh");
      setCodexModelOverride(b, "lsrc", 9, "gpt-6.1-sol", "xhigh");
      expect(selectedCodexProfile(a, "claw", 5).id).toBe("2");
      expect(selectedCodexProfile(a, "lsrc", 9).id).toBe("2");
      expect(codexModelOverride(b, "claw", 5)).toEqual({ model: "gpt-6.1-sol", effort: "xhigh" });
    } finally { rmSync(root, { recursive: true, force: true }); }
  });
});
