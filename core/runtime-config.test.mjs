import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ensureRuntimeConfig, materializeRuntimeConfig } from "./runtime-config.mjs";

describe("runtime agent configuration", () => {
  it("generates one private runtime file and preserves it when unchanged", () => {
    const root = mkdtempSync(join(tmpdir(), "amux-runtime-config-"));
    const sourcePath = join(root, "agentmux.yaml");
    const generatedPath = join(root, "runtime", "agents.yaml");
    writeFileSync(sourcePath, "agents:\n  demo:\n    dir: /tmp/demo\n    codex: 1\n");
    try {
      expect(materializeRuntimeConfig({ sourcePath, generatedPath }).changed).toBe(true);
      expect(readFileSync(generatedPath, "utf8")).toContain("codex --yolo");
      expect(statSync(generatedPath).mode & 0o777).toBe(0o600);
      chmodSync(generatedPath, 0o600);
      expect(materializeRuntimeConfig({ sourcePath, generatedPath }).changed).toBe(false);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("preserves an explicitly configured generated-only legacy install", () => {
    const root = mkdtempSync(join(tmpdir(), "amux-runtime-legacy-"));
    const generatedPath = join(root, "agents.yaml");
    writeFileSync(generatedPath, "demo:\n  dir: /tmp/demo\n");
    try {
      expect(ensureRuntimeConfig({
        sourcePath: join(root, "missing-agentmux.yaml"), generatedPath,
      })).toMatchObject({ changed: false, legacy: true });
      expect(readFileSync(generatedPath, "utf8")).toContain("/tmp/demo");
    }
    finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("repairs a demo runtime view from the operator-owned source", () => {
    const root = mkdtempSync(join(tmpdir(), "amux-runtime-repair-"));
    const sourcePath = join(root, "agentmux.yaml");
    const generatedPath = join(root, "agents.yaml");
    writeFileSync(sourcePath, "agents:\n  real-fleet:\n    dir: /srv/real\n    codex: 1\n");
    writeFileSync(generatedPath, "demo-project:\n  dir: /tmp/demo\n");
    try {
      expect(ensureRuntimeConfig({ sourcePath, generatedPath }).changed).toBe(true);
      const repaired = readFileSync(generatedPath, "utf8");
      expect(repaired).toContain("real-fleet:");
      expect(repaired).not.toContain("demo-project:");
      expect(readFileSync(sourcePath, "utf8")).toContain("/srv/real");
    }
    finally { rmSync(root, { recursive: true, force: true }); }
  });
});
