import { execFileSync } from "child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, runMeasurementProof } from "./measurement-proof.mjs";

const roots = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

const git = (root, args) => execFileSync("git", ["-C", root, ...args], { encoding: "utf8" }).trim();

const fixture = () => {
  const root = mkdtempSync(join(tmpdir(), "amux-measurement-test-"));
  roots.push(root);
  git(root, ["init", "-q"]);
  git(root, ["config", "user.email", "proof@example.test"]);
  git(root, ["config", "user.name", "Proof Test"]);
  git(root, ["remote", "add", "origin", "git@github.com:example/proof.git"]);
  writeFileSync(join(root, "feature.txt"), "old\n");
  writeFileSync(join(root, "fixture.txt"), "fixture-anchor\n");
  writeFileSync(join(root, "gate.mjs"), `
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
const fixture = readFileSync("fixture.txt", "utf8").trim();
const feature = readFileSync("feature.txt", "utf8").trim();
if (process.env.PROOF_COUNTER) appendFileSync(process.env.PROOF_COUNTER,
  process.env.AMUX_MEASUREMENT_PHASE + "\\n");
if (process.env.DIRTY_GATE === process.env.AMUX_MEASUREMENT_PHASE) {
  writeFileSync("gate-dirt.txt", "must be rejected\\n");
}
const phase = process.env.AMUX_MEASUREMENT_PHASE;
const observed = Number(process.env[phase === "red" ? "RED_OBSERVED" : "GREEN_OBSERVED"]
  ?? (phase === "red" ? 12 : 4));
const limit = Number(process.env[phase === "red" ? "RED_LIMIT" : "GREEN_LIMIT"] ?? 10);
if (process.env.OMIT_MEASUREMENT_PHASE !== phase) {
  writeFileSync(process.env.AMUX_MEASUREMENT_OUTPUT, JSON.stringify({
    metric: "pixel-error", unit: "px", operator: "<=", limit, observed,
  }));
}
process.exit(fixture === "fixture-enabled" && feature === "fixed" ? 0 : 23);
`.trimStart());
  git(root, ["add", "."]);
  git(root, ["commit", "-qm", "base"]);
  const baseSha = git(root, ["rev-parse", "HEAD"]);
  writeFileSync(join(root, "fixture.txt"), "fixture-enabled\n");
  writeFileSync(join(root, "red-first-helper.mjs"), "export const asserted = true;\n");
  git(root, ["add", "-N", "red-first-helper.mjs"]);
  const patch = join(root, "fixture.patch");
  writeFileSync(patch, git(root, ["diff", "--", "fixture.txt", "red-first-helper.mjs"]) + "\n");
  writeFileSync(join(root, "feature.txt"), "fixed\n");
  git(root, ["add", "feature.txt", "fixture.txt", "red-first-helper.mjs"]);
  git(root, ["commit", "-qm", "fix"]);
  const headSha = git(root, ["rev-parse", "HEAD"]);
  return { root, patch, baseSha, headSha };
};

const config = (fx) => ({
  schemaVersion: 1,
  ticketId: "SRC-0092",
  assignmentGeneration: 7,
  repository: fx.root,
  baseRef: fx.baseSha,
  headRef: fx.headSha,
  fixturePatch: fx.patch,
  anchor: { path: "fixture.txt", contains: "fixture-anchor" },
  gate: { argv: [process.execPath, "gate.mjs"], cwd: "." },
});

describe("measurement proof runner", () => {
  it("runs the asserted fixture red once and the fixed head green once with computed margin", () => {
    const fx = fixture();
    const counter = join(fx.root, "counter.log");
    process.env.PROOF_COUNTER = counter;
    let proof;
    try {
      proof = runMeasurementProof(config(fx), { now: () => 1_784_100_000_000 });
    } finally {
      delete process.env.PROOF_COUNTER;
    }
    expect(proof).toMatchObject({
      schemaVersion: 1,
      producer: "amux.measurement-proof.v1",
      ticketId: "SRC-0092",
      assignmentGeneration: 7,
      repository: { baseSha: fx.baseSha, headSha: fx.headSha },
      fixture: { anchorAsserted: true, mutationApplied: true, noOp: false,
        changedFiles: ["fixture.txt", "red-first-helper.mjs"] },
      red: { exitCode: 23, attempts: 1, cleanCheckout: true, writeRetry: false },
      green: { exitCode: 0, attempts: 1, cleanCheckout: true, writeRetry: false },
      margin: { metric: "pixel-error", unit: "px", operator: "<=",
        limit: 10, observed: 4, margin: 6 },
      generatedAt: 1_784_100_000_000,
    });
    expect(proof.attestationHash).toMatch(/^sha256:[a-f0-9]{64}$/u);
    expect(canonicalJson(proof)).not.toContain("undefined");
    expect(readFileSync(counter, "utf8")).toBe("red\ngreen\n");
    expect(git(fx.root, ["worktree", "list", "--porcelain"]).match(/worktree /gu)).toHaveLength(1);
  });

  it("rejects identical observed values from the red and green phases", () => {
    const fx = fixture();
    process.env.RED_OBSERVED = "4";
    try {
      expect(() => runMeasurementProof(config(fx)))
        .toThrow("red and green measurements must have different observed values");
    } finally {
      delete process.env.RED_OBSERVED;
    }
  });

  it("rejects a red measurement that already satisfies the limit", () => {
    const fx = fixture();
    process.env.RED_OBSERVED = "5";
    try {
      expect(() => runMeasurementProof(config(fx)))
        .toThrow("red measurement must violate the limit");
    } finally {
      delete process.env.RED_OBSERVED;
    }
  });

  it("rejects incomparable phase boundaries instead of reporting a measured margin", () => {
    const fx = fixture();
    process.env.RED_LIMIT = "11";
    try {
      expect(() => runMeasurementProof(config(fx)))
        .toThrow("red and green measurement boundaries must match");
    } finally {
      delete process.env.RED_LIMIT;
    }
  });

  it("requires the real gate to emit a measurement in the red phase", () => {
    const fx = fixture();
    process.env.OMIT_MEASUREMENT_PHASE = "red";
    try {
      expect(() => runMeasurementProof(config(fx)))
        .toThrow("red gate did not write valid measurement JSON");
    } finally {
      delete process.env.OMIT_MEASUREMENT_PHASE;
    }
  });

  it("fails before execution when the asserted anchor is absent", () => {
    const fx = fixture();
    expect(() => runMeasurementProof({ ...config(fx),
      anchor: { path: "fixture.txt", contains: "fabricated-anchor" } }))
      .toThrow("fixture anchor assertion failed before mutation");
  });

  it("rejects source-grep as a claimed gate", () => {
    const fx = fixture();
    expect(() => runMeasurementProof({ ...config(fx), gate: { argv: ["rg", "fixed"], cwd: "." } }))
      .toThrow("not shell/source grep");
  });

  it("fails if either real gate dirties an untracked file", () => {
    const fx = fixture();
    process.env.DIRTY_GATE = "green";
    try {
      expect(() => runMeasurementProof(config(fx))).toThrow("gate changed files outside fixture");
    } finally {
      delete process.env.DIRTY_GATE;
    }
  });
});
