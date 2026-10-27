import { expect, feature, component } from "bdd-vitest";
import { vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClaimGuardRuntime } from "./claim-guard-runtime.mjs";

feature("the optional claim policy cannot take down human delivery", () => {
  component("an unavailable private state area visibly disables the policy", {
    given: ["a path occupied by a file", () => {
      const dir = mkdtempSync(join(tmpdir(), "claim-startup-")), path = join(dir, "not-directory");
      writeFileSync(path, "occupied");
      return { dir, path, warn: vi.spyOn(console, "warn").mockImplementation(() => {}) };
    }],
    when: ["starting the policy", fixture => ({ ...fixture,
      guard: createClaimGuardRuntime({ discord: {}, broker: {}, dir: fixture.path, env: {} }) })],
    then: ["startup returns instead of throwing into the bridge", ({ guard, warn }) => {
      expect(guard).toBeNull(); expect(warn).toHaveBeenCalledWith(expect.stringContaining("human delivery remains enabled"));
    }],
    cleanup: ({ dir, warn }) => { warn.mockRestore(); rmSync(dir, { recursive: true, force: true }); },
  });
});
