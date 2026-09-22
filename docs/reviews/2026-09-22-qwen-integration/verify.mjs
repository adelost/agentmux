// Offline review runner. The repository's bdd-vitest entry uses the same scenarios.
// Run with --experimental-vm-modules. No installs, model calls, tmux or fleet writes.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createHash } from "node:crypto";
import { SourceTextModule, SyntheticModule } from "node:vm";
import * as fs from "node:fs";
import * as crypto from "node:crypto";
import { qwenReaderCases } from "../../../test/qwen-review-reader-cases.mjs";
import { qwenRuntimeCases } from "../../../test/qwen-review-runtime-cases.mjs";

const root = process.argv[2] ? resolve(process.argv[2]) : fileURLToPath(new URL("../../../", import.meta.url));
const reader = await import(pathToFileURL(`${root}/core/qwen-jsonl-reader.mjs`));
const runtimePath = `${root}/core/qwen-agent-runtime.mjs`;
const raw = readFileSync(runtimePath);
const quote = (s) => "'" + String(s).replaceAll("'", "'\\''") + "'";
const collaborators = {
  "node:fs": fs, "node:crypto": crypto, "./qwen-jsonl-reader.mjs": reader,
  "./agent-launch-command.mjs": { buildQwenLaunchCommand: (o) =>
    `${quote(o.executable)} ${o.resume ? "--resume" : "--session-id"} ${quote(o.sessionId)} --json-file ${quote(o.eventPath)} --input-file ${quote(o.inputPath)}` },
  "../lib.mjs": { esc: (s) => String(s).replaceAll("'", "'\\''") },
};
const runtime = new SourceTextModule(raw.toString("utf8"), { identifier: runtimePath });
await runtime.link((name) => {
  const exports = collaborators[name];
  if (!exports) throw new Error(`Unmapped runtime collaborator: ${name}`);
  return new SyntheticModule(Object.keys(exports), function () {
    for (const [key, value] of Object.entries(exports)) this.setExport(key, value);
  });
});
await runtime.evaluate();
const results = [];
for (const { id, run } of [
  ...qwenReaderCases(reader), ...qwenRuntimeCases(runtime.namespace.createQwenAgentRuntime, reader),
]) {
  try { await run(); results.push({ id, passed: true }); }
  catch (error) { results.push({ id, passed: false, error: error.message }); }
}
const hashes = {};
for (const path of ["core/qwen-jsonl-reader.mjs", "core/qwen-agent-runtime.mjs"]) {
  const bytes = readFileSync(resolve(root, path));
  hashes[path] = createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex");
}
console.log(JSON.stringify({ node: process.version, sourceGitBlobs: hashes,
  scope: "Full reader and filesystem. Full runtime with substituted command builder/escape helper and tmux. Not the installed Qwen CLI, actual launch builder, bdd-vitest runner or full AMUX suite.",
  passed: results.filter(r => r.passed).length, failed: results.filter(r => !r.passed).length, results }, null, 2));
process.exitCode = results.some(r => !r.passed) ? 1 : 0;
