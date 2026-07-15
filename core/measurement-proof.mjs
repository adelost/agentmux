// Machine-owned red/green measurement attestations for completion evidence.
// The runner creates detached worktrees, applies the test-only fixture to the
// base, and executes each gate exactly once. Callers cannot supply outcomes.

import { spawnSync } from "child_process";
import { createHash } from "crypto";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { basename, dirname, isAbsolute, join, resolve } from "path";

/** WHAT: Names the cross-repository proof producer. WHY: Keeps receipts from accepting unknown measurement authorities. */
export const MEASUREMENT_PROOF_PRODUCER = "amux.measurement-proof.v1";
const FORBIDDEN_GATE_COMMANDS = new Set([
  "bash", "dash", "fish", "grep", "rg", "sh", "zsh",
]);
const SHA = /^[a-f0-9]{40}$/u;
const TICKET = /^[A-Z][A-Z0-9]*-[0-9]{4,}$/u;

const isObject = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);
const sha256 = (value) => `sha256:${createHash("sha256").update(value).digest("hex")}`;

/** WHAT: Encodes stable cross-repository JSON. WHY: Keeps object key order from changing attestation identities. */
export function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isObject(value)) {
    return `{${Object.keys(value).sort().map((key) =>
      `${JSON.stringify(key.normalize("NFC"))}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  if (typeof value === "string") return JSON.stringify(value.normalize("NFC"));
  const encoded = JSON.stringify(value);
  if (encoded === undefined) throw new Error("measurement proof cannot canonicalize undefined");
  return encoded;
}

function boundedString(value, label, { min = 1, max = 2_000 } = {}) {
  if (typeof value !== "string" || value.length < min || value.length > max
    || /[\u0000]/u.test(value)) throw new Error(`config: ${label} is invalid`);
  return value;
}

function relativePath(value, label, { dot = false } = {}) {
  const path = boundedString(value, label, { max: 500 });
  if (isAbsolute(path) || (path === "." ? !dot
    : path.split(/[\\/]/u).some((part) => part === ".." || part === "." || part === ""))) {
    throw new Error(`config: ${label} must be a normalized relative path`);
  }
  return path.replaceAll("\\", "/");
}

function argv(value, label) {
  if (!Array.isArray(value) || value.length < 1 || value.length > 64
    || value.some((item) => typeof item !== "string" || !item || item.length > 2_000
      || /[\u0000]/u.test(item))) throw new Error(`config: ${label}.argv is invalid`);
  return [...value];
}

function commandSpec(value, label, { optional = false } = {}) {
  if (value == null && optional) return null;
  if (!isObject(value) || Object.keys(value).some((key) => !["argv", "cwd"].includes(key))) {
    throw new Error(`config: ${label} is invalid`);
  }
  return { argv: argv(value.argv, label),
    cwd: relativePath(value.cwd ?? ".", `${label}.cwd`, { dot: true }) };
}

function parseConfig(value, configDir) {
  if (!isObject(value) || Object.keys(value).some((key) => ![
    "schemaVersion", "ticketId", "assignmentGeneration", "repository", "baseRef", "headRef",
    "fixturePatch", "anchor", "prepare", "gate",
  ].includes(key)) || value.schemaVersion !== 1 || !TICKET.test(String(value.ticketId))) {
    throw new Error("config: measurement proof v1 object required");
  }
  const generation = Number(value.assignmentGeneration);
  if (!Number.isSafeInteger(generation) || generation < 1) {
    throw new Error("config: assignmentGeneration must be positive");
  }
  const repositoryRaw = boundedString(value.repository, "repository", { max: 2_000 });
  const patchRaw = boundedString(value.fixturePatch, "fixturePatch", { max: 2_000 });
  const repository = resolve(configDir, repositoryRaw);
  const fixturePatch = resolve(configDir, patchRaw);
  if (!existsSync(repository) || !existsSync(fixturePatch)) {
    throw new Error("config: repository and fixturePatch must exist");
  }
  if (!isObject(value.anchor) || Object.keys(value.anchor).some((key) =>
    !["path", "contains"].includes(key))) throw new Error("config: anchor is invalid");
  const anchor = {
    path: relativePath(value.anchor.path, "anchor.path"),
    contains: boundedString(value.anchor.contains, "anchor.contains", { max: 8_000 }),
  };
  const gate = commandSpec(value.gate, "gate");
  const executable = basename(gate.argv[0]).toLowerCase();
  if (FORBIDDEN_GATE_COMMANDS.has(executable)
    || (executable === "git" && gate.argv[1] === "grep")) {
    throw new Error("config: gate must execute a real build/test entry point, not shell/source grep");
  }
  return {
    schemaVersion: 1,
    ticketId: value.ticketId,
    assignmentGeneration: generation,
    repository,
    baseRef: boundedString(value.baseRef, "baseRef", { max: 500 }),
    headRef: boundedString(value.headRef, "headRef", { max: 500 }),
    fixturePatch,
    anchor,
    prepare: commandSpec(value.prepare, "prepare", { optional: true }),
    gate,
  };
}

function run(executable, args, { cwd, env = process.env, allowFailure = false } = {}) {
  const started = Date.now();
  const result = spawnSync(executable, args, {
    cwd,
    env,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
  const exitCode = result.status == null ? 255 : result.status;
  if (result.error) throw result.error;
  if (result.status == null && result.signal) {
    throw new Error(`${executable} ${args.join(" ")} terminated by ${result.signal}`);
  }
  if (!allowFailure && exitCode !== 0) {
    throw new Error(`${executable} ${args.join(" ")} failed (${exitCode}): ${result.stderr}`);
  }
  return {
    exitCode,
    durationMs: Math.max(0, Date.now() - started),
    stdout: result.stdout ?? "",
    stderr: result.stderr ?? "",
  };
}

function git(repo, args, options = {}) {
  return run("git", ["-C", repo, ...args], options).stdout.trim();
}

function cleanLines(value) {
  return value.split("\n").map((line) => line.trim()).filter(Boolean).sort();
}

function workingTreeFiles(worktree) {
  const tracked = cleanLines(git(worktree, ["diff", "HEAD", "--name-only", "--"]));
  const untracked = cleanLines(git(worktree, ["ls-files", "--others", "--exclude-standard"]));
  return [...new Set([...tracked, ...untracked])].sort();
}

function verifyClean(worktree, expectedChanged = []) {
  const changed = workingTreeFiles(worktree);
  const expected = [...expectedChanged].sort();
  if (JSON.stringify(changed) !== JSON.stringify(expected)) {
    throw new Error(`gate changed files outside fixture: expected [${expected}], got [${changed}]`);
  }
}

function measurementResult(path) {
  let value;
  try { value = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { throw new Error(`green gate did not write valid measurement JSON: ${error.message}`); }
  if (!isObject(value) || Object.keys(value).some((key) =>
    !["metric", "unit", "operator", "limit", "observed"].includes(key))) {
    throw new Error("measurement result has unknown or missing fields");
  }
  const metric = boundedString(value.metric, "measurement.metric", { max: 120 });
  const unit = boundedString(value.unit, "measurement.unit", { max: 40 });
  const operator = value.operator === "<=" || value.operator === ">=" ? value.operator : null;
  const limit = Number(value.limit);
  const observed = Number(value.observed);
  if (!operator || !Number.isFinite(limit) || !Number.isFinite(observed)) {
    throw new Error("measurement result must contain finite limit/observed values");
  }
  const margin = operator === "<=" ? limit - observed : observed - limit;
  if (!(margin > 0)) throw new Error(`measurement has no passing margin (${margin})`);
  return { metric, unit, operator, limit, observed, margin };
}

function gateResult(result) {
  return {
    exitCode: result.exitCode,
    durationMs: result.durationMs,
    attempts: 1,
    cleanCheckout: true,
    writeRetry: false,
    stdoutSha256: sha256(result.stdout),
    stderrSha256: sha256(result.stderr),
  };
}

/** WHAT: Builds one clean red-first measurement proof. WHY: Keeps hand-written outcomes from entering completion receipts. */
export function runMeasurementProof(input, { now = Date.now } = {}) {
  const configPath = typeof input === "string" ? resolve(input) : null;
  const raw = configPath ? JSON.parse(readFileSync(configPath, "utf8")) : input;
  const config = parseConfig(raw, configPath ? dirname(configPath) : process.cwd());
  const baseSha = git(config.repository, ["rev-parse", `${config.baseRef}^{commit}`]);
  const headSha = git(config.repository, ["rev-parse", `${config.headRef}^{commit}`]);
  if (!SHA.test(baseSha) || !SHA.test(headSha) || baseSha === headSha) {
    throw new Error("proof requires two distinct commit refs");
  }
  const remote = git(config.repository, ["remote", "get-url", "origin"]);
  const fixtureBytes = readFileSync(config.fixturePatch);
  if (!fixtureBytes.length) throw new Error("fixture patch is empty");
  const root = mkdtempSync(join(tmpdir(), "amux-measurement-proof-"));
  const baseDir = join(root, "base");
  const headDir = join(root, "head");
  const resultPath = join(root, "measurement.json");
  let baseAdded = false;
  let headAdded = false;
  try {
    git(config.repository, ["worktree", "add", "--detach", baseDir, baseSha]);
    baseAdded = true;
    git(config.repository, ["worktree", "add", "--detach", headDir, headSha]);
    headAdded = true;
    if (git(baseDir, ["status", "--porcelain"]) || git(headDir, ["status", "--porcelain"])) {
      throw new Error("proof worktrees are not clean after checkout");
    }
    const anchorText = readFileSync(join(baseDir, config.anchor.path), "utf8");
    if (!anchorText.includes(config.anchor.contains)) {
      throw new Error("fixture anchor assertion failed before mutation");
    }
    git(baseDir, ["apply", "--check", config.fixturePatch]);
    git(baseDir, ["apply", config.fixturePatch]);
    const changedFiles = workingTreeFiles(baseDir);
    if (!changedFiles.length) throw new Error("fixture mutation was a no-op");
    // The head must already contain the identical test fixture; otherwise the
    // red and green samples are not measuring the same boundary.
    git(headDir, ["apply", "--reverse", "--check", config.fixturePatch]);

    for (const worktree of [baseDir, headDir]) {
      if (config.prepare) run(config.prepare.argv[0], config.prepare.argv.slice(1), {
        cwd: resolve(worktree, config.prepare.cwd),
        env: { ...process.env, NO_COLOR: "1" },
      });
    }
    verifyClean(baseDir, changedFiles);
    verifyClean(headDir, []);

    const executeGate = (worktree, phase) => {
      rmSync(resultPath, { force: true });
      return run(config.gate.argv[0], config.gate.argv.slice(1), {
        cwd: resolve(worktree, config.gate.cwd),
        allowFailure: true,
        env: {
          ...process.env,
          NO_COLOR: "1",
          AMUX_MEASUREMENT_OUTPUT: resultPath,
          AMUX_MEASUREMENT_PHASE: phase,
        },
      });
    };
    const red = executeGate(baseDir, "red");
    if (red.exitCode === 0) throw new Error("red-first gate unexpectedly passed");
    verifyClean(baseDir, changedFiles);
    const green = executeGate(headDir, "green");
    if (green.exitCode !== 0) {
      throw new Error(`green gate failed (${green.exitCode}); stderr=${green.stderr}`);
    }
    verifyClean(headDir, []);
    const margin = measurementResult(resultPath);
    const generatedAt = now();
    if (!Number.isSafeInteger(generatedAt) || generatedAt < 0) {
      throw new Error("measurement proof clock returned an invalid timestamp");
    }
    const unsigned = {
      schemaVersion: 1,
      producer: MEASUREMENT_PROOF_PRODUCER,
      ticketId: config.ticketId,
      assignmentGeneration: config.assignmentGeneration,
      repository: { remote, baseSha, headSha },
      fixture: {
        patchSha256: sha256(fixtureBytes),
        anchor: { path: config.anchor.path, containsSha256: sha256(config.anchor.contains) },
        anchorAsserted: true,
        mutationApplied: true,
        noOp: false,
        changedFiles,
      },
      gate: { argv: config.gate.argv, cwd: config.gate.cwd },
      red: gateResult(red),
      green: gateResult(green),
      margin,
      generatedAt,
    };
    return { ...unsigned, attestationHash: sha256(canonicalJson(unsigned)) };
  } finally {
    if (baseAdded) run("git", ["-C", config.repository, "worktree", "remove", "--force", baseDir],
      { allowFailure: true });
    if (headAdded) run("git", ["-C", config.repository, "worktree", "remove", "--force", headDir],
      { allowFailure: true });
    rmSync(root, { recursive: true, force: true });
  }
}

/** WHAT: Saves one canonical attestation file. WHY: Keeps persisted and returned proof identities on identical bytes. */
export function writeMeasurementProof(input, outputPath, options = {}) {
  const proof = runMeasurementProof(input, options);
  if (outputPath) writeFileSync(resolve(outputPath), `${canonicalJson(proof)}\n`, "utf8");
  return proof;
}

/** WHAT: Dispatches proof CLI arguments. WHY: Keeps argv parsing separate from the measurement runner boundary. */
export function runMeasurementProofCommand(args) {
  let config = null;
  let output = null;
  for (let index = 0; index < args.length; index += 1) {
    const flag = args[index];
    const value = args[index + 1];
    if ((flag !== "--config" && flag !== "--output") || !value || value.startsWith("--")) {
      throw new Error("Usage: amux proof --config <proof.json> [--output <attestation.json>]");
    }
    if (flag === "--config") config = value;
    else output = value;
    index += 1;
  }
  if (!config) throw new Error("Usage: amux proof --config <proof.json> [--output <attestation.json>]");
  const proof = writeMeasurementProof(config, output);
  console.log(canonicalJson(proof));
  return proof;
}
