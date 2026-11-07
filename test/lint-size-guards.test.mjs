import { afterEach, describe, expect, it, vi } from "vitest";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lintRoot, lintRoots, findingFingerprint } from "../core/contract-lint.mjs";
import { cmdLint } from "../cli/lint.mjs";

const dirs = [];
const git = (dir, ...args) => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
function fixture(cap) {
  const dir = mkdtempSync(join(tmpdir(), "amux-size-guard-")); dirs.push(dir);
  git(dir, "init", "-b", "main");
  git(dir, "config", "user.name", "Fixture"); git(dir, "config", "user.email", "fixture@example.invalid");
  writeFileSync(join(dir, "large.mjs"), "// source\n".repeat(cap || 1));
  if (cap) grow(dir, cap);
  git(dir, "add", "."); git(dir, "commit", "-m", "trunk"); git(dir, "checkout", "-b", "feature");
  return dir;
}
function grow(dir, cap) {
  writeFileSync(join(dir, "large.mjs"), "// source\n".repeat(cap));
  writeFileSync(join(dir, ".amux-lint.yml"), `fileSize:\n  caps:\n    large.mjs: ${cap}\n`);
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0;
});
describe("mandatory trunk-anchored size guards", () => {
  it("rejects staged and unstaged ledgers even in changed mode and names the writer", () => {
    const root = fixture();
    mkdirSync(join(root, "docs"));
    writeFileSync(join(root, "docs/TASKS.md"), "| 1 | open |\n");
    git(root, "add", "docs/TASKS.md"); git(root, "commit", "-m", "ledger");
    writeFileSync(join(root, "docs/TASKS.md"), "| 1 | done |\n");
    const dirty = () => lintRoots([root], { changed: true, strict: true })[0].activeFindings;
    expect(dirty()).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "LEDGER001", msg: expect.stringContaining("push_ledger.sh") }),
    ]));
    git(root, "add", "docs/TASKS.md");
    expect(dirty().some(f => f.code === "LEDGER001")).toBe(true);
  });
  it("leaves saved ledger reference copies outside the live-ledger guard", () => {
    const root = fixture();
    mkdirSync(join(root, "reference"));
    writeFileSync(join(root, "reference/TASKS.md"), "| saved | unregistered |\n");
    writeFileSync(join(root, "TASKS-frozen.md"), "| saved | reference |\n");
    writeFileSync(join(root, "TASKS-origin-master.md"), "| saved | reference |\n");
    expect(lintRoots([root], { changed: true, strict: true })[0].activeFindings).toEqual([]);
  });
  it("uses default 500 when known trunk has no policy", () => {
    const root = fixture(); grow(root, 501);
    expect(lintRoot(root, { changed: true, strict: true }).findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: "STYLE011" }),
    ]));
  });
  it("keeps actual trunk history even when diff base is feature HEAD", () => {
    const root = fixture(501); grow(root, 502); git(root, "add", "."); git(root, "commit", "-m", "increase");
    vi.stubEnv("AMUX_LINT_BASE_REF", "HEAD");
    const result = lintRoot(root, { changed: true, strict: true, baseRef: "HEAD" });
    expect(result.files).toEqual([join(root, "large.mjs")]);
    expect(result.findings.some((f) => f.code === "STYLE011")).toBe(true);
  });
  it("checks actual file growth against trunk even when HEAD hides the diff and no policy changed", () => {
    const root = fixture();
    writeFileSync(join(root, "large.mjs"), "// source\n".repeat(501));
    git(root, "add", "."); git(root, "commit", "-m", "oversized without policy");
    vi.stubEnv("AMUX_LINT_BASE_REF", "HEAD");
    const result = lintRoot(root, { changed: true, strict: true, baseRef: "HEAD" });
    expect(result.findings.some((f) => f.code === "STYLE010")).toBe(true);
    expect(result.files).toEqual([join(root, "large.mjs")]);
    expect(result.symbols).toBe(0);
  });
  it("does not suppress size guards through new or pre-existing baselines", () => {
    const root = fixture(501); grow(root, 502);
    const baselinePath = join(root, "baseline.json"), options = { changed: true, strict: true, baselinePath };
    const result = lintRoot(root, options);
    writeFileSync(baselinePath, JSON.stringify({ findings: result.findings.map((f) => findingFingerprint(f, root)) }));
    expect(lintRoots([root], options)[0].activeFindings.some((f) => f.code === "STYLE011")).toBe(true);
    expect(lintRoots([root], { ...options, updateBaseline: true })[0].activeFindings.some((f) => f.code === "STYLE011")).toBe(true);
    expect(readFileSync(baselinePath, "utf8")).not.toContain("STYLE011");
  });
  it("fails loud on malformed trunk policy and unknown policy trunk", () => {
    const root = fixture(); writeFileSync(join(root, ".amux-lint.yml"), "[bad\n");
    git(root, "add", "."); git(root, "commit", "-m", "invalid"); git(root, "branch", "-f", "main", "HEAD");
    expect(() => lintRoot(root, { strict: true })).toThrow("invalid trunk policy");
    git(root, "branch", "-D", "main");
    expect(() => lintRoot(root, { strict: true })).toThrow("policy trunk is unknown");
  });
  it("preserves existing unchanged caps", () => {
    const root = fixture(501);
    expect(lintRoot(root, { changed: true, strict: true }).findings).toEqual([]);
  });
  it.each([["--skip", "contract"], ["--only", "typo"], ["--skip", "typo"]])("rejects strict opt-out %j", async (...flags) => {
    await expect(cmdLint(["--strict", ...flags], {})).rejects.toThrow(/unknown check|cannot skip/);
  });
  it("keeps CLI strict red while updating a baseline", async () => {
    const root = fixture(501); grow(root, 502);
    vi.spyOn(console, "log").mockImplementation(() => {});
    await cmdLint([root, "--changed", "--strict", "--update-baseline"], {});
    expect(process.exitCode).toBe(1);
  });
});
