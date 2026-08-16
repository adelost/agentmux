import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { feature, unit, component, expect } from "bdd-vitest";

import { relativeImportClosure } from "./install-hooks.mjs";

const binDir = dirname(fileURLToPath(import.meta.url));
const coreDir = resolve(binDir, "..", "core");
const guard = join(binDir, "suggestions-write-guard.mjs");

const SUGGESTIONS_BASE_URL = "https://tasks.example.test";
const MUTATION = `curl -X PATCH ${SUGGESTIONS_BASE_URL}/api/tickets/DEMO-0001/admin?project=demo`;

// Run the guard the way the hook does: a JSON payload on stdin, and the exit
// code is the whole contract. Only 2 blocks; the runtime reads everything else
// as "allowed", which is why a crashing guard is a silently open gate.
const runGuard = (guardPath, command) => {
  const run = spawnSync(process.execPath, [guardPath], {
    encoding: "utf8",
    env: { ...process.env, SUGGEST_BASE_URL: SUGGESTIONS_BASE_URL },
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command } }),
  });
  return { status: run.status, stderr: run.stderr ?? "" };
};

/** A throwaway copy of the installed layout, so the real ~/.agentmux is untouched. */
const installedCopy = (coreFiles) => {
  const root = mkdtempSync(join(tmpdir(), "amux-guard-install-"));
  mkdirSync(join(root, "hooks"), { recursive: true });
  mkdirSync(join(root, "core"), { recursive: true });
  copyFileSync(guard, join(root, "hooks", "suggestions-write-guard.mjs"));
  for (const name of coreFiles) copyFileSync(join(coreDir, name), join(root, "core", name));
  return { root, guardPath: join(root, "hooks", "suggestions-write-guard.mjs") };
};

feature("The installed Suggestions guard cannot quietly stop guarding", () => {
  unit("copies every core module the guard can reach, not just the entry one", {
    given: ["the guard's own dependency graph", () => join(coreDir, "suggestions-authoring.mjs")],
    when: ["deriving what must be installed beside it", (entry) => [...relativeImportClosure(entry)]],
    then: ["the transitive import is included, not only the entry file", (closure) => {
      // core/mangled-swedish.mjs was added as a new import and the hardcoded
      // one-file copy list did not follow. The installed guard then imported a
      // file that was never installed.
      expect(closure.map((path) => path.slice(coreDir.length + 1)).sort())
        .toEqual(["mangled-swedish.mjs", "runtime-defaults.mjs", "suggestions-authoring.mjs"]);
    }],
  });

  unit("importing the installer does not rewrite the caller's settings", {
    // This module exports relativeImportClosure, so it gets imported. Without an
    // entrypoint guard that import runs main() and rewrites ~/.claude/settings.json
    // — which happened while writing this change.
    given: ["the installer imported rather than executed", () => relativeImportClosure],
    when: ["checking what the import produced", (fn) => typeof fn],
    then: ["only the helper, no installation", (kind) => expect(kind).toBe("function")],
  });

  component("a complete install blocks the inline mutation", {
    given: ["the guard installed with its whole closure", () => installedCopy(
      ["suggestions-authoring.mjs", "mangled-swedish.mjs", "runtime-defaults.mjs"],
    )],
    when: ["a pane tries a direct curl mutation", (ctx) => runGuard(ctx.guardPath, MUTATION)],
    then: ["it is refused with the blocking exit code", (result, ctx) => {
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("BLOCKED");
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });

  component("an incomplete install fails CLOSED instead of open", {
    given: ["the guard installed without its transitive import", () => installedCopy(
      ["suggestions-authoring.mjs"],
    )],
    when: ["a pane tries the same mutation", (ctx) => runGuard(ctx.guardPath, MUTATION)],
    then: ["it still blocks, and names why it is degraded", (result, ctx) => {
      // Before this change the process aborted at module load and exited 1, which
      // the hook contract treats as permission. The fleet ran ungated in silence.
      expect(result.status).toBe(2);
      expect(result.stderr).toContain("BLOCKED");
      expect(result.stderr).toContain("could not load its rule");
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });

  component("a degraded guard still lets unrelated commands through", {
    given: ["the same broken install", () => installedCopy(["suggestions-authoring.mjs"])],
    when: ["running a command that has nothing to do with Suggestions",
      (ctx) => runGuard(ctx.guardPath, "git status --short")],
    then: ["it is allowed, so a broken guard cannot brick the shell", (result, ctx) => {
      expect(result.status).toBe(0);
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });

  component("a core module that reaches outside core/ is refused at install time", {
    given: ["a core file importing a sibling directory", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-guard-escape-"));
      mkdirSync(join(root, "core"), { recursive: true });
      writeFileSync(join(root, "outside.mjs"), "export const x = 1;\n");
      writeFileSync(join(root, "core", "entry.mjs"),
        "import { x } from \"../outside.mjs\";\nexport { x };\n");
      return { root, entry: join(root, "core", "entry.mjs") };
    }],
    when: ["deriving its closure", (ctx) => [...relativeImportClosure(ctx.entry)]],
    then: ["the escape is visible to the installer's guard clause", (closure, ctx) => {
      const escaped = closure.filter((path) => dirname(path) !== join(ctx.root, "core"));
      expect(escaped).toHaveLength(1);
      expect(readFileSync(join(ctx.root, "core", "entry.mjs"), "utf8")).toContain("../outside.mjs");
      rmSync(ctx.root, { recursive: true, force: true });
    }],
  });
});
