import { component, feature, unit, expect } from "bdd-vitest";
import { execFileSync } from "child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { bankMemory, formatMemoryBank, scanAddedSecrets } from "./memory-bank.mjs";

const git = (root, ...args) => execFileSync("git", args, { cwd: root, encoding: "utf-8" }).trim();
// Built at runtime so this file itself never carries a token-shaped string.
const FAKE_KEY = ["sk", "ant", "x".repeat(30)].join("-");

function repo() {
  const root = mkdtempSync(join(tmpdir(), "amux-memory-bank-"));
  mkdirSync(join(root, "memory"), { recursive: true });
  writeFileSync(join(root, "memory", "old.md"), "> summary: old\n");
  writeFileSync(join(root, "notes.txt"), "base\n");
  git(root, "init", "-q");
  git(root, "config", "user.email", "test@example.com");
  git(root, "config", "user.name", "Test");
  git(root, "add", ".");
  git(root, "commit", "-q", "-m", "base");
  return root;
}

feature("memory bank", () => {
  component("only memory paths are committed and other staged work stays staged", {
    given: ["a new note, an edited note and someone else's staged file", () => {
      const root = repo();
      writeFileSync(join(root, "memory", "2026-10-10.md"), "> summary: today\n");
      writeFileSync(join(root, "memory", "old.md"), "> summary: old, edited\n");
      writeFileSync(join(root, "notes.txt"), "someone else's work\n");
      git(root, "add", "notes.txt");
      return root;
    }],
    when: ["banking", (root) => ({ root, result: bankMemory(root) })],
    then: ["one commit with both notes; notes.txt still staged and unpushed", ({ root, result }) => {
      expect(result.banked).toBe(2);
      expect(git(root, "show", "--name-only", "--format=%s", "HEAD").split("\n").sort())
        .toEqual(["", "chore(memory): bank 2 file(s)", "memory/2026-10-10.md", "memory/old.md"].sort());
      expect(git(root, "diff", "--cached", "--name-only")).toBe("notes.txt");
      expect(git(root, "remote")).toBe("");
    }],
  });

  component("a secret-shaped added line stops the commit and is reported without its value", {
    given: ["a note with a pasted key", () => {
      const root = repo();
      writeFileSync(join(root, "memory", "2026-10-10.md"), `> summary: today\nnyckel ${FAKE_KEY}\n`);
      return root;
    }],
    when: ["banking", (root) => ({ root, result: bankMemory(root) })],
    then: ["nothing committed, our staging undone, location reported", ({ root, result }) => {
      expect(result.skipped).toBe("secret-pattern");
      expect(result.hits).toEqual([{ file: "memory/2026-10-10.md", line: 2, kind: "anthropic-key" }]);
      expect(git(root, "log", "--format=%s")).toBe("base");
      expect(git(root, "diff", "--cached", "--name-only")).toBe("");
      expect(formatMemoryBank(result)).not.toContain(FAKE_KEY);
    }],
  });

  component("nothing pending commits nothing", {
    given: ["a clean repo", () => repo()],
    when: ["banking", (root) => bankMemory(root)],
    then: ["banked 0", (result) => { expect(result.banked).toBe(0); }],
  });

  unit("only added lines count, so an old value in history never blocks a night", {
    given: ["a diff that removes a key and adds a plain line", () => [
      "+++ b/memory/a.md", "@@ -3 +3 @@", `-${FAKE_KEY}`, "+plain text",
    ].join("\n")],
    when: ["scanning", (diff) => scanAddedSecrets(diff)],
    then: ["no hits", (hits) => { expect(hits).toEqual([]); }],
  });
});
