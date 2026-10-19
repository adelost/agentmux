import { feature, component, expect } from "bdd-vitest";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const HOOK = resolve(import.meta.dirname, "reactive-poke.mjs");

// The Stop hook read only its checkout's .env, so retiring that file
// (2026-10-19) would have switched the reactive mirror off for a session
// started without the amux environment. It now reads ~/.agentmux/.env first.
async function runHookWithoutAmuxEnvironment() {
  const home = mkdtempSync(join(tmpdir(), "amux-reactive-poke-"));
  const dir = join(home, "project");
  mkdirSync(join(home, ".agentmux"));
  mkdirSync(dir);
  const pokes = [];
  const server = createServer((req, res) => { pokes.push(`${req.method} ${req.url}`); res.end("ok"); });
  await new Promise((done) => server.listen(0, "127.0.0.1", done));
  const agentsYaml = join(home, "agents.yaml");
  writeFileSync(agentsYaml, `demo:\n  dir: ${dir}\n  panes:\n    - cmd: claude\n`);
  writeFileSync(join(home, ".agentmux", ".env"), [
    "AMUX_REACTIVE_POKE=1", "AMUX_REACTIVE_POKE_LOG=0",
    `VOICE_PWA_PORT=${server.address().port}`, `AGENTS_YAML=${agentsYaml}`,
  ].join("\n"));
  try {
    const child = spawn(process.execPath, [HOOK], { env: { HOME: home, PATH: process.env.PATH }, stdio: ["pipe", "ignore", "ignore"] });
    child.stdin.end(JSON.stringify({ cwd: dir }));
    await new Promise((done) => child.once("exit", done));
    return pokes;
  } finally {
    server.close();
    rmSync(home, { recursive: true, force: true });
  }
}

feature("reactive poke stop hook configuration", () => {
  component("a session without the amux environment pokes its pane from the operator's ~/.agentmux/.env", {
    when: ["the Stop hook runs in the pane's directory", runHookWithoutAmuxEnvironment],
    then: ["the pane gets exactly one poke", (pokes) => expect(pokes).toEqual(["POST /api/poke/demo/0"])],
  });
});
