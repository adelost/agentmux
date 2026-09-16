import { expect, feature, integration } from "bdd-vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync, spawnSync } from "node:child_process";
import { cmdHotspots } from "../cli/hotspots.mjs";
import { HOTSPOT_GUARD_CMD } from "../bin/install-hooks.mjs";

const IDENTITY = {
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
};
const run = (cwd, ...args) => execFileSync("git", args, { cwd, env: { ...process.env, ...IDENTITY }, encoding: "utf8" });

/** `step` gains one surviving branch per version, so each trunk commit keeps lines in it; `idle` returns `idleValue`. */
const source = (version, idleValue = 0) => `export function step(state) {
${Array.from({ length: version }, (_, index) => `  if (state.phase === "p${index + 1}") return { ...state, v: ${index + 1} };`).join("\n")}
  return state;
}

export function idle() {
  return ${idleValue};
}
`;

/** A clone whose trunk has changed `step` six times (three of them fixes) and `idle` once. */
function repoWithHotStep() {
  const root = mkdtempSync(join(tmpdir(), "amux-hotspot-guard-"));
  const origin = join(root, "origin.git");
  const clone = join(root, "clone");
  run(root, "init", "-q", "--bare", "-b", "main", origin);
  run(root, "clone", "-q", origin, clone);
  run(clone, "checkout", "-q", "-b", "main");
  for (let version = 1; version <= 6; version++) {
    writeFileSync(join(clone, "flight.js"), source(version));
    run(clone, "add", "flight.js");
    run(clone, "commit", "-q", "-m", version % 2 ? `fix(flight): step ${version}` : `feat: step ${version}`);
  }
  run(clone, "push", "-q", "-u", "origin", "main");
  run(clone, "remote", "set-head", "origin", "main");
  return { root, clone, ledger: join(root, "ledger") };
}

/** Runs the exact command the installer registers, shell pre-filter included. */
function guard(clone, ledger, command) {
  return spawnSync("bash", ["-c", HOTSPOT_GUARD_CMD], {
    input: JSON.stringify({ tool_name: "Bash", tool_input: { command }, cwd: clone }),
    env: { ...process.env, AMUX_HOTSPOTS_DIR: ledger },
    encoding: "utf8",
  });
}

feature("hotspot commit guard", () => {
  integration("a commit changing a hot function waits for a verdict, and the verdict releases it", {
    given: ["a trunk where step changed six times and a working edit inside step", () => {
      const repo = repoWithHotStep();
      writeFileSync(join(repo.clone, "flight.js"), source(6).replace('v: 3 }', 'v: 33 }'));
      run(repo.clone, "add", "flight.js");
      return repo;
    }],
    when: ["committing, recording a verdict, and committing again", async ({ clone, ledger }) => {
      const held = guard(clone, ledger, 'git commit -m "tune step"');
      process.env.AMUX_HOTSPOTS_DIR = ledger;
      try {
        await cmdHotspots(["verdict", "flight.js::step", "KEEP", "fixes were velocity constants, not branching", "--repo", clone]);
      } finally {
        delete process.env.AMUX_HOTSPOTS_DIR;
      }
      return { held, released: guard(clone, ledger, 'git commit -m "tune step"') };
    }],
    then: ["the first commit is blocked with the brief, the second passes", ({ held, released }, { root }) => {
      expect(held.status, held.stderr).toBe(2);
      expect(held.stderr).toContain("flight.js:1 step · 6 commits, 3 fixes");
      expect(held.stderr).toContain("amux churn verdict 'flight.js::step'");
      expect(released.status, released.stderr).toBe(0);
      rmSync(root, { recursive: true, force: true });
    }],
  }, { timeout: 60_000 });

  integration("a verdict recorded earlier in the same shell command releases that commit", {
    given: ["the hot step trunk and a working edit inside step", () => {
      const repo = repoWithHotStep();
      writeFileSync(join(repo.clone, "flight.js"), source(6).replace('v: 3 }', 'v: 33 }'));
      return repo;
    }],
    when: ["committing in a chain that records the verdict first", ({ clone, ledger }) =>
      guard(clone, ledger, `amux churn verdict 'flight.js::step' KEEP "velocity constants only" && git commit -am tune`)],
    then: ["the guard lets the chain run", (result, { root }) => {
      expect(result.status, result.stderr).toBe(0);
      rmSync(root, { recursive: true, force: true });
    }],
  }, { timeout: 60_000 });

  integration("a commit touching only a cold function passes without a brief", {
    given: ["the same trunk and a working edit inside idle only", () => {
      const repo = repoWithHotStep();
      writeFileSync(join(repo.clone, "flight.js"), source(6, 42));
      return repo;
    }],
    when: ["committing", ({ clone, ledger }) => guard(clone, ledger, "git commit -am idle")],
    then: ["the guard allows it silently", (result, { root }) => {
      expect(result.status, result.stderr).toBe(0);
      expect(result.stdout).toBe("");
      rmSync(root, { recursive: true, force: true });
    }],
  }, { timeout: 60_000 });
});
