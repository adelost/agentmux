import { execFileSync } from "node:child_process";
import {
  chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { extname, join } from "node:path";
import { expect, test } from "vitest";

const tracked = execFileSync("git", ["ls-files"], { encoding: "utf8" })
  .trim().split("\n").filter(Boolean);

const isProductionCore = (path) => {
  if (path.startsWith("docs/") || path.startsWith("test/") || path.startsWith("link/")
    || path.startsWith("android/") || path.startsWith("spikes/")
    || /(?:^|\/)fixtures\//u.test(path) || /\.test\.[^.]+$/u.test(path)) return false;
  return new Set([".mjs", ".js", ".sh", ".ps1", ".yaml", ".example"]).has(extname(path));
};

test("production core contains no private installation defaults", () => {
  const forbidden = /(?:[a-z0-9-]+\.)+v1d\.io|\/home\/adelost|openclaw-claude\.sock|sv-SE-MattiasNeural|E:\\_Sdk|abyss-windows|lsrc\/agentmux/iu;
  const findings = tracked.filter(isProductionCore).flatMap((path) => {
    const source = readFileSync(path, "utf8");
    return forbidden.test(source) ? [path] : [];
  });
  expect(findings).toEqual([]);
});

test("installed core excludes separately deployed first-party applications", () => {
  const npmIgnore = readFileSync(".npmignore", "utf8").split(/\r?\n/u);
  expect(npmIgnore).toContain("android/");
  expect(npmIgnore).toContain("link/");
});

test("public source has a real license and keeps full autonomy intentional", () => {
  expect(existsSync("LICENSE")).toBe(true);
  expect(readFileSync("LICENSE", "utf8")).toContain("MIT License");
  const policy = readFileSync("core/execution-safety.mjs", "utf8");
  expect(policy).toContain("--dangerously-skip-permissions");
  expect(policy).toContain("--yolo");
  expect(policy).toContain('sandbox: "danger-full-access"');
});

test("setup bootstraps standalone config in a clean home", () => {
  const root = mkdtempSync(join(tmpdir(), "agentmux-clean-home-"));
  const home = join(root, "home");
  const fakeBin = join(root, "bin");
  mkdirSync(home, { recursive: true });
  mkdirSync(fakeBin, { recursive: true });
  const command = (name, source) => {
    const path = join(fakeBin, name);
    writeFileSync(path, `#!/bin/sh\n${source}\n`);
    chmodSync(path, 0o755);
  };
  command("node", `if [ "$1" = "-v" ]; then echo v22.0.0; else exec ${JSON.stringify(process.execPath)} "$@"; fi`);
  command("tmux", "echo 'tmux 3.4'");
  command("codex", "exit 0");
  try {
    const cleanEnv = {
      ...process.env,
      HOME: home,
      PATH: `${fakeBin}:${process.env.PATH}`,
      AMUX_SETUP_SKIP_CLI_INSTALL: "1",
    };
    for (const key of ["AGENTS_YAML", "AGENT_CONFIG", "AGENTMUX_YAML", "AMUX_DISCORD_ENV"]) {
      delete cleanEnv[key];
    }
    const output = execFileSync("bash", ["bin/setup.sh"], {
      cwd: process.cwd(),
      env: cleanEnv,
      encoding: "utf8",
    });
    const configHome = join(home, ".agentmux");
    expect(output).toContain("Ready!");
    expect(readFileSync(join(configHome, ".env"), "utf8")).toContain("DISCORD_TOKEN=");
    expect(readFileSync(join(configHome, "agentmux.yaml"), "utf8")).toContain("agents: {}");
    expect(readFileSync(join(configHome, "agents.yaml"), "utf8")).toMatch(/\n\{\}\s*$/u);
    expect(statSync(join(configHome, ".env")).mode & 0o777).toBe(0o600);
    expect(statSync(join(configHome, "agentmux.yaml")).mode & 0o777).toBe(0o600);
    expect(statSync(join(configHome, "agents.yaml")).mode & 0o777).toBe(0o600);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
