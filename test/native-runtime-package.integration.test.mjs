import { execFileSync } from "node:child_process";
import { createServer } from "node:net";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { stopNativeRuntime } from "../cli/native-runtime-service.mjs";
import { stageReleaseArtifact } from "../core/release-install.mjs";

const repo = resolve(import.meta.dirname, "..");
const cleanups = [];

afterEach(async () => {
  while (cleanups.length) await cleanups.pop()();
});

const availablePort = () => new Promise((resolvePort, rejectPort) => {
  const server = createServer();
  server.once("error", rejectPort);
  server.listen(0, "127.0.0.1", () => {
    const { port } = server.address();
    server.close(() => resolvePort(port));
  });
});

const installArtifact = (artifactPath, prefix) => execFileSync("npm", [
  "install", "--prefix", prefix, "--ignore-scripts", "--omit=optional",
  "--no-audit", "--no-fund", "--force", artifactPath,
], { encoding: "utf8" });

describe("packed native runtime lifecycle", () => {
  it("starts from the exact tarball and starts again after package replacement", async () => {
    const root = mkdtempSync(join(tmpdir(), "amux-packed-runtime-"));
    const outputRoot = join(root, "artifact");
    const prefix = join(root, "prefix");
    const home = join(root, "home");
    const configHome = join(home, ".agentmux");
    const stateDir = join(root, "state");
    const dataDir = join(root, "data");
    const sourceSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repo, encoding: "utf8",
    }).trim();
    const staged = stageReleaseArtifact({ repoRoot: repo, sourceSha, outputRoot });
    const requiredRuntimeFiles = [
      "spikes/web-ui/server.mjs",
      "spikes/web-ui/runtime-control.mjs",
      "spikes/web-ui/runtime-prompt.mjs",
      "spikes/web-ui/persistent-claude-runtime.mjs",
      "spikes/web-ui/index.html",
      "spikes/web-ui/app.js",
      "spikes/web-ui/quota-observation.js",
      "spikes/web-ui/style.css",
    ];
    for (const path of requiredRuntimeFiles) {
      expect(staged.manifest.files[path], path).toMatch(/^[0-9a-f]{64}$/u);
    }

    mkdirSync(configHome, { recursive: true });
    writeFileSync(join(configHome, ".env"), "DISCORD_TOKEN=\n", { mode: 0o600 });
    writeFileSync(join(configHome, "agentmux.yaml"), "agents: {}\n", { mode: 0o600 });
    const port = await availablePort();
    const env = {
      ...process.env,
      HOME: home,
      AGENTMUX_YAML: join(configHome, "agentmux.yaml"),
      AGENTS_YAML: join(configHome, "agents.yaml"),
      AMUX_DISCORD_ENV: join(configHome, ".env"),
    };
    const cliArgs = (action) => [
      "runtime", action,
      "--port", String(port),
      "--state-dir", stateDir,
      "--data-dir", dataDir,
      "--no-legacy-migration",
    ];
    const packageRoot = join(prefix, "node_modules", "agentmux");
    const binary = join(prefix, "node_modules", ".bin", "amux");
    const run = (action) => execFileSync(binary, cliArgs(action), {
      env, encoding: "utf8", timeout: 20_000,
    });
    cleanups.push(async () => {
      await stopNativeRuntime({
        port, stateDir, dataDir, legacyDataDir: null, force: true,
      }).catch(() => {});
      rmSync(root, { recursive: true, force: true });
    });

    installArtifact(staged.artifactPath, prefix);
    expect(run("start")).toContain("now online");
    expect(run("check")).toContain("Native runtime healthy");
    expect(run("stop")).toContain("Native runtime stopped");
    const replacementMarker = join(packageRoot, ".replacement-proof");
    writeFileSync(replacementMarker, "first installation\n");

    rmSync(packageRoot, { recursive: true, force: true });
    expect(existsSync(packageRoot)).toBe(false);
    installArtifact(staged.artifactPath, prefix);
    expect(existsSync(replacementMarker)).toBe(false);
    expect(readFileSync(join(packageRoot, "package.json"), "utf8"))
      .toContain('"name": "agentmux"');

    expect(run("start")).toContain("now online");
    expect(run("check")).toContain("Native runtime healthy");
    expect(run("stop")).toContain("Native runtime stopped");
  }, 90_000);
});
