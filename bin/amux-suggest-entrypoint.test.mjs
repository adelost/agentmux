import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { feature, unit, expect } from "bdd-vitest";

const cli = fileURLToPath(new URL("./amux-suggest.mjs", import.meta.url));

// Every pane invokes this CLI as ~/.local/bin/amux-suggest, a symlink. Running
// the file by its own path therefore proves nothing about the entrypoint guard:
// the only invocation that can catch a broken guard is one through a symlink.
// Both streams, always: the CLI writes its usage to stderr and exits 0, so a
// stdout-only reading of a working run is indistinguishable from a run that
// never happened — the exact confusion this test exists to prevent.
const runThroughSymlink = (...args) => {
  const dir = mkdtempSync(join(tmpdir(), "amux-suggest-link-"));
  const link = join(dir, "amux-suggest");
  try {
    symlinkSync(cli, link);
    const run = spawnSync(process.execPath, [link, ...args], { encoding: "utf8" });
    return `${run.stdout ?? ""}${run.stderr ?? ""}`;
  }
  finally { rmSync(dir, { recursive: true, force: true }); }
};

feature("The sanctioned client actually runs when a pane invokes it", () => {
  unit("prints its usage when reached through the symlink every pane uses", {
    given: ["the CLI behind a symlink, asked for help", () => ["--help"]],
    when: ["a pane runs it the way PATH resolves it", (args) => runThroughSymlink(...args)],
    then: ["it produces output instead of exiting silently", (output) =>
      expect(output.length).toBeGreaterThan(0)],
  });

  unit("fails loud on a missing required flag rather than exiting quiet", {
    given: ["a call with no --body-file", () => ["--method", "POST", "--path", "/api/x"]],
    when: ["a pane runs it through the symlink", (args) => runThroughSymlink(...args)],
    then: ["the reason is named on the way out", (output) =>
      expect(output).toContain("--body-file")],
  });

  unit("still stays inert when the module is merely imported", {
    given: ["the module path", () => cli],
    when: ["a test imports it for its exports", (path) => {
      const run = spawnSync(process.execPath,
        ["--input-type=module", "-e", `await import(${JSON.stringify(path)})`],
        { encoding: "utf8" });
      return `${run.stdout ?? ""}${run.stderr ?? ""}`;
    }],
    then: ["importing runs no request and prints nothing", (output) =>
      expect(output).toBe("")],
  });
});
