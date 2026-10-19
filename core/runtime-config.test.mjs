import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import yaml from "js-yaml";
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

  it("gives a pane back the channel the last /sync bound to it after a regeneration lost it", () => {
    // 2026-10-19: a regeneration from a checkout's July agentmux.yaml dropped
    // sandman; the next one brought it back without #sandman-0.
    const root = mkdtempSync(join(tmpdir(), "amux-runtime-synced-"));
    const sourcePath = join(root, "agentmux.yaml");
    const stalePath = join(root, "july-agentmux.yaml");
    const generatedPath = join(root, "agents.yaml");
    const statePath = join(root, "state.json");
    writeFileSync(sourcePath, "agents:\n  curator:\n    dir: /tmp/curator\n    claude: 1\n    codex: 1\n  demo:\n    dir: /tmp/demo\n    codex: 1\n");
    writeFileSync(stalePath, "agents:\n  demo:\n    dir: /tmp/demo\n    codex: 1\n");
    writeFileSync(statePath, JSON.stringify({ sync: { channels: { "curator-0": "111", "curator-1-codex": "222", "demo-0-codex": "333" } } }));
    writeFileSync(generatedPath, "curator:\n  dir: /tmp/curator\n  discord:\n    \"111\": 0\n    \"222\": 1\ndemo:\n  dir: /tmp/demo\n  discord:\n    \"333\": 0\n");
    try {
      materializeRuntimeConfig({ sourcePath: stalePath, generatedPath, statePath });
      const result = materializeRuntimeConfig({ sourcePath, generatedPath, statePath });
      const generated = yaml.load(readFileSync(generatedPath, "utf8"));
      expect(generated.curator.discord).toEqual({ 111: 0, 222: 1 });
      expect(generated.demo.discord).toEqual({ 333: 0 });
      expect(result.restored).toEqual(["curator-0", "curator-1-codex"]);
    }
    finally { rmSync(root, { recursive: true, force: true }); }
  });

  it("never moves a bound pane to its old /sync channel nor binds a pane the source lacks", () => {
    const root = mkdtempSync(join(tmpdir(), "amux-runtime-synced-guard-"));
    const sourcePath = join(root, "agentmux.yaml");
    const generatedPath = join(root, "agents.yaml");
    const statePath = join(root, "state.json");
    writeFileSync(sourcePath, "agents:\n  demo:\n    dir: /tmp/demo\n    codex: 1\n");
    writeFileSync(statePath, JSON.stringify({ sync: { channels: { "demo-0-codex": "333", "demo-1-codex": "444" } } }));
    writeFileSync(generatedPath, "demo:\n  dir: /tmp/demo\n  discord:\n    \"555\": 0\n");
    try {
      const result = materializeRuntimeConfig({ sourcePath, generatedPath, statePath });
      expect(yaml.load(readFileSync(generatedPath, "utf8")).demo.discord).toEqual({ 555: 0 });
      expect(result.restored).toEqual([]);
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
