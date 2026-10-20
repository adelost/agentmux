import { component, feature, unit, expect } from "bdd-vitest";
import { afterEach, vi } from "vitest";
import { existsSync, readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cmdLint } from "../cli/lint.mjs";
import { formatRulesReport, gitRead, lintRules } from "./rules-lint.mjs";
import { loadLintPolicy } from "./lint-ratchet.mjs";
import { commit, createRepo, createWorld, fetchOrigin, git, push, removeWorld, setOriginHead, writeText } from "../test/rules-lint-world.mjs";

// Every git call the lint makes is recorded here while `recording` is on, whichever process API makes it.
const spy = vi.hoisted(() => ({ recording: false, calls: [] }));
vi.mock("node:child_process", async (importOriginal) => {
  const real = await importOriginal();
  const record = (file, args) => { if (spy.recording && file === "git") spy.calls.push(args); };
  return {
    ...real,
    execFileSync: (file, args, options) => { record(file, args); return real.execFileSync(file, args, options); },
    spawnSync: (file, args, options) => { record(file, args); return real.spawnSync(file, args, options); },
  };
});

// Guards: I-1 (read-only), I-2 (errors are certain), UC-1 and UC-2 (one run over repos, one repo from its own
// directory), UC-4 (a checkout far behind trunk), R-2 (fetch time), R-4 (the right trunk), R-5 (the setting reaches).
const worlds = [];
afterEach(() => {
  for (const world of worlds.splice(0)) removeWorld(world);
  vi.restoreAllMocks(); vi.unstubAllEnvs(); process.exitCode = 0; spy.recording = false; spy.calls.length = 0;
});

const newWorld = (options) => { const world = createWorld(options); worlds.push(world); return world; };
const lint = (world, repos, extra = {}) =>
  lintRules([].concat(repos).map((repo) => repo.root || repo), { home: world.home, profilesDir: world.profilesDir, ...extra });
const findings = (run, tag) => run.repos[0].findings.filter((f) => f.tag === tag);
const SHARED = "# Shared layer\n- Pick one option and say which evidence or criterion made it win, never leave it up to the reader.\n";
const SIX_RULES = ["# Rules", "- one", "- two", "- three", "- four", "- five", ""].join("\n");

/** A repo on main with trunk pushed, an AGENTS.md and its origin/HEAD set, the shape of a normal pane clone. */
function pushedRepo(world, name, files = { "AGENTS.md": SIX_RULES }) {
  const repo = createRepo(world, name);
  commit(repo, files, "rules");
  push(repo);
  setOriginHead(repo, "main");
  return repo;
}

/** A repo whose rule file has every kind of certain error and of heuristic, with his words removed and moved. */
function richRepo(world) {
  const repo = createRepo(world, "rich");
  const filler = Array.from({ length: 1300 }, (_, i) => `- filler rule number ${i}`).join("\n");
  commit(repo, {
    "AGENTS.md": [
      "# Rules",
      "Run `npm run build` and `npm run missing-script`; targets `make build` and `make nope`.",
      "Docs: `docs/guide.md`, `docs/gone.md`, [guide](docs/guide.md#intro), [dead](docs/guide.md#nowhere).",
      "Example only: `docs/example-only.md` and shape `docs/<name>/x.md`.",
      'Mattias 2026-10-19: "never skip the gate on a friday", said twice.',
      'Mattias 2026-10-20: "keep rule files short and honest", moved later.',
      "The router (295 lines) holds 72 task handlers; the sync is not deployed.",
      "Pick one option and say which evidence or criterion made it win, never leave it up to the reader.",
      filler, "",
    ].join("\n"),
    "CLAUDE.md": "@AGENTS.md\n",
    "package.json": JSON.stringify({ scripts: { build: "tsc" } }),
    Makefile: "build:\n\t@true\n",
    "docs/guide.md": "# Guide\n\n## Intro\n",
  }, "rich rules");
  const text = readFileSync(join(repo.root, "AGENTS.md"), "utf8").split("\n");
  commit(repo, {
    "AGENTS.md": text.filter((line) => !line.includes("Mattias 2026-10-19") && !line.includes("Mattias 2026-10-20")).join("\n"),
    "docs/his-words.md": '# His words\nMattias 2026-10-20: "keep rule files short and honest", moved later.\n',
  }, "tidy rules");
  push(repo);
  setOriginHead(repo, "main");
  fetchOrigin(repo);
  return repo;
}

/** Captures what cmdLint prints, with HOME pointing at the fixture home. */
async function runCli(world, args) {
  vi.stubEnv("HOME", world.home); vi.stubEnv("AMUX_ACCOUNT_PROFILES_DIR", "");
  const lines = [];
  vi.spyOn(console, "log").mockImplementation((text) => lines.push(String(text)));
  await cmdLint(args, {});
  return lines.join("\n");
}

const snapshot = (repo) => ({
  refs: git(repo.root, "for-each-ref"),
  head: git(repo.root, "rev-parse", "HEAD"),
  files: readFileSync(join(repo.root, "AGENTS.md"), "utf8"),
  index: statSync(join(repo.root, ".git", "index")).mtimeMs,
  fetchHead: existsSync(join(repo.root, ".git", "FETCH_HEAD")) ? statSync(join(repo.root, ".git", "FETCH_HEAD")).mtimeMs : null,
});
const READ_ONLY = ["rev-parse", "symbolic-ref", "for-each-ref", "ls-tree", "show", "cat-file", "rev-list", "log", "grep", "config"];

feature("rules lint trunk and checkout", () => {
  component("follows origin/HEAD", {
    given: ["a remote whose default branch is develop, next to a different main", () => {
      const world = newWorld();
      const repo = createRepo(world, "headed", { branch: "develop" });
      commit(repo, { "AGENTS.md": "# Develop rules\n" }, "develop");
      push(repo, "develop");
      git(repo.root, "checkout", "-q", "-b", "main");
      commit(repo, { "AGENTS.md": "# Main rules\n" }, "main");
      push(repo, "main");
      git(repo.root, "checkout", "-q", "develop");
      setOriginHead(repo, "develop");
      return { world, repo };
    }],
    when: ["linting the repo", ({ world, repo }) => lint(world, repo)],
    then: ["trunk is the branch origin/HEAD points to, and the header says so", (run) => {
      expect(run.repos[0].trunk).toMatchObject({ ref: "origin/develop", remote: true });
      expect(run.repos[0].header).toContain("trunk origin/develop");
    }],
  });

  component("falls back to main without a remote", {
    given: ["a repo with no remote on main", () => {
      const world = newWorld();
      const repo = createRepo(world, "local", { remote: false });
      commit(repo, { "AGENTS.md": "# Rules\n" }, "rules");
      return { world, repo };
    }],
    when: ["linting the repo", ({ world, repo }) => lint(world, repo)],
    then: ["trunk is the local main and the header says there is no remote", (run) => {
      expect(run.repos[0].trunk).toMatchObject({ ref: "main", remote: false });
      expect(run.repos[0].header).toContain("trunk main, no remote");
    }],
  });

  component("reads rules.trunk", {
    given: ["a main without docs/new.md, a preview with it, and a policy that names preview", () => {
      const world = newWorld();
      const repo = createRepo(world, "integration");
      commit(repo, { "AGENTS.md": "# Rules\nSee `docs/new.md`.\n" }, "rules");
      push(repo);
      git(repo.root, "checkout", "-q", "-b", "preview");
      commit(repo, { "docs/new.md": "new\n" }, "add the doc");
      push(repo, "preview");
      git(repo.root, "checkout", "-q", "main");
      setOriginHead(repo, "main");
      writeText(join(repo.root, ".amux-lint.yml"), "rules:\n  trunk: origin/preview\n");
      return { world, repo };
    }],
    when: ["linting with the policy and then without it", ({ world, repo }) => {
      const named = lint(world, repo);
      writeFileSync(join(repo.root, ".amux-lint.yml"), "# no rules key\n");
      return { named, plain: lint(world, repo) };
    }],
    then: ["the named trunk decides what exists and the default trunk reports the file", ({ named, plain }) => {
      expect(named.repos[0].trunk).toMatchObject({ ref: "origin/preview", source: "rules.trunk" });
      expect(findings(named, "exists")).toEqual([]);
      expect(plain.repos[0].trunk.ref).toBe("origin/main");
      expect(findings(plain, "exists")).toHaveLength(1);
    }],
  });

  component("keeps the existing keys of .amux-lint.yml", {
    given: ["a policy with file caps and rules.trunk, and one with a bad rules.trunk", () => {
      const world = newWorld();
      const good = join(world.dir, "good"); const bad = join(world.dir, "bad");
      writeText(join(good, ".amux-lint.yml"), "fileSize:\n  caps:\n    a.mjs: 3\nrules:\n  trunk: origin/preview\n");
      writeText(join(good, "a.mjs"), "1\n2\n3\n");
      writeText(join(bad, ".amux-lint.yml"), "rules:\n  trunk: 5\n");
      return { good, bad };
    }],
    when: ["loading both policies", ({ good, bad }) => ({ good: loadLintPolicy(good, []), bad: loadLintPolicy(bad, []) })],
    then: ["the caps survive, the trunk is read and a bad value is a config finding", ({ good, bad }) => {
      expect(good).toMatchObject({ fileCaps: { "a.mjs": 3 }, rulesTrunk: "origin/preview", configFindings: [] });
      expect(bad.configFindings).toEqual([expect.objectContaining({ msg: expect.stringMatching(/rules\.trunk/) })]);
    }],
  });

  component("flags a detached checkout behind trunk", {
    given: ["a checkout detached at a commit with trunk 3 commits ahead", () => {
      const world = newWorld();
      const repo = createRepo(world, "far");
      commit(repo, { "AGENTS.md": SIX_RULES }, "one");
      const base = commit(repo, { "docs/a.md": "a\n" }, "two");
      for (const n of [3, 4, 5]) commit(repo, { [`docs/f${n}.md`]: "x\n" }, `c${n}`);
      push(repo); setOriginHead(repo, "main");
      git(repo.root, "checkout", "-q", "--detach", base);
      return { world, repo, base };
    }],
    when: ["linting the repo", ({ world, repo }) => lint(world, repo)],
    then: ["one checkout error names the commit, the distance and trunk", (run, { base }) => {
      expect(findings(run, "checkout")).toEqual([expect.objectContaining({
        sev: "error", msg: `checkout detached at ${base.slice(0, 7)}, 3 behind origin/main`,
      })]);
      expect(run.repos[0].header).toContain(`detached at ${base.slice(0, 7)}, 3 behind`);
    }],
  });

  component("flags a checkout more than 50 commits behind trunk", {
    given: ["a main branch that is 51 commits behind origin/main", () => {
      const world = newWorld();
      const repo = createRepo(world, "stale");
      const base = commit(repo, { "AGENTS.md": SIX_RULES }, "one");
      for (let n = 0; n < 51; n += 1) git(repo.root, "commit", "-q", "--allow-empty", "-m", `later ${n}`);
      push(repo); setOriginHead(repo, "main");
      git(repo.root, "reset", "-q", "--hard", base);
      return { world, repo };
    }],
    when: ["linting the repo", ({ world, repo }) => lint(world, repo)],
    then: ["the distance is an error even on the branch itself", (run) => {
      expect(findings(run, "checkout")).toEqual([expect.objectContaining({ sev: "error", msg: "checkout is 51 commits behind origin/main" })]);
    }],
  });

  component("warns on another branch", {
    given: ["a feature branch one commit ahead of trunk", () => {
      const world = newWorld();
      const repo = pushedRepo(world, "branched");
      git(repo.root, "checkout", "-q", "-b", "feat/x");
      commit(repo, { "docs/x.md": "x\n" }, "feature work");
      return { world, repo };
    }],
    when: ["linting the repo", ({ world, repo }) => lint(world, repo)],
    then: ["it is a warning that names the branch, not an error", (run) => {
      expect(findings(run, "branch")).toEqual([expect.objectContaining({ sev: "warn", msg: "checkout is on feat/x, 1 ahead, 0 behind origin/main" })]);
      expect(findings(run, "checkout")).toEqual([]);
    }],
  });

  component("warns on a loaded file unlike trunk", {
    given: ["a working tree that edits two lines of AGENTS.md and deletes CLAUDE.md", () => {
      const world = newWorld();
      const repo = pushedRepo(world, "loaded", { "AGENTS.md": SIX_RULES, "CLAUDE.md": "@AGENTS.md\n" });
      writeFileSync(join(repo.root, "AGENTS.md"), SIX_RULES.replace("- two", "- TWO").replace("- four", "- FOUR"));
      git(repo.root, "rm", "-q", "-f", "CLAUDE.md");
      return { world, repo };
    }],
    when: ["linting the repo", ({ world, repo }) => lint(world, repo)],
    then: ["both files warn, with the differing lines or the missing file", (run) => {
      const loaded = findings(run, "loaded");
      expect(loaded.map((f) => [f.file, f.sev])).toEqual(expect.arrayContaining([["AGENTS.md", "warn"], ["CLAUDE.md", "warn"]]));
      expect(loaded.find((f) => f.file === "AGENTS.md").msg).toBe("panes load a different file than origin/main, lines differ: 3, 5");
      expect(loaded.find((f) => f.file === "CLAUDE.md").msg).toBe("panes load no CLAUDE.md, but origin/main has one");
    }],
  });

  component("prints the fetch time of the trunk ref", {
    given: ["one clone fetched at a known time and one that never fetched", () => {
      const world = newWorld();
      const fetched = pushedRepo(world, "fetched");
      fetchOrigin(fetched);
      const stamp = new Date(2026, 9, 20, 9, 36);
      utimesSync(join(fetched.root, ".git", "FETCH_HEAD"), stamp, stamp);
      const never = pushedRepo(world, "never");
      return { world, fetched, never };
    }],
    when: ["linting both", ({ world, fetched, never }) => lint(world, [fetched, never])],
    then: ["each header carries the fetch time or says never", (run) => {
      expect(run.repos[0].header).toContain("fetched 2026-10-20 09:36");
      expect(run.repos[1].header).toContain("fetched never");
    }],
  });

  component("reads a work tree whose config says bare", {
    given: ["a repo with core.bare set to true and a dead path in its rule file", () => {
      const world = newWorld();
      const repo = pushedRepo(world, "oddly-bare", { "AGENTS.md": "# Rules\nSee `docs/gone.md`.\n" });
      git(repo.root, "config", "core.bare", "true");
      return { world, repo };
    }],
    when: ["linting the repo", ({ world, repo }) => lint(world, repo)],
    then: ["it is linted, not skipped", (run) => {
      expect(run.repos[0].skipped).toBeNull();
      expect(findings(run, "exists")).toHaveLength(1);
    }],
  });
});

feature("rules lint severity, reach and read-only", () => {
  component("runs only read-only git commands", {
    given: ["a rich repo, and its refs, head, rule file and index as they are", () => {
      const world = newWorld({ layers: { "lsrc/.agents/CLAUDE.md": SHARED } });
      const repo = richRepo(world);
      return { world, repo, before: snapshot(repo) };
    }],
    when: ["linting it while recording every git call, and trying forbidden ones", ({ world, repo }) => {
      spy.recording = true;
      const run = lint(world, repo);
      spy.recording = false;
      const forbidden = [
        ["fetch", "origin"], ["checkout", "-q", "main"], ["commit", "-m", "x"], ["gc"], ["branch", "-D", "main"],
        ["update-ref", "-d", "refs/heads/main"], ["symbolic-ref", "HEAD", "refs/heads/other"], ["config", "user.name", "x"],
        ["log", "--output=/tmp/x"], ["reset", "--hard"], ["stash"],
      ].map((args) => { try { gitRead(repo.root, args); return null; } catch (error) { return String(error.message); } });
      return { run, calls: [...spy.calls], forbidden };
    }],
    then: ["only read commands ran, forbidden ones throw, and nothing in the repo changed", ({ run, calls, forbidden }, { repo, before }) => {
      expect(calls.length).toBeGreaterThan(5);
      for (const args of calls) {
        const command = args[0] === "-C" ? args[2] : args[0];
        expect(READ_ONLY).toContain(command);
        if (command === "config") expect(args[3]).toBe("--get");
        if (command === "symbolic-ref") expect(args.slice(3).filter((a) => !a.startsWith("-"))).toHaveLength(1);
      }
      expect(forbidden.every((message) => /read-only/.test(message || ""))).toBe(true);
      expect(snapshot(repo)).toEqual(before);
      expect(run.repos[0].findings.length).toBeGreaterThan(5);
    }],
  });

  component("keeps heuristics as warnings", {
    given: ["a rule file with counts, status claims, a repeat of the layer and 31 KB, on a feature branch with an edit", () => {
      const world = newWorld({ layers: { "lsrc/.agents/CLAUDE.md": SHARED } });
      const filler = Array.from({ length: 1300 }, (_, i) => `- filler rule number ${i}`).join("\n");
      const repo = pushedRepo(world, "heuristic", {
        "AGENTS.md": `# Rules\nThe router (295 lines) holds 72 task handlers; the sync is not deployed.\n${SHARED.split("\n")[1]}\n${filler}\n`,
        "CLAUDE.md": "@AGENTS.md\n",
      });
      git(repo.root, "checkout", "-q", "-b", "feat/y");
      writeFileSync(join(repo.root, "AGENTS.md"), `${readFileSync(join(repo.root, "AGENTS.md"), "utf8")}- local edit\n`);
      return { world, repo };
    }],
    when: ["linting the repo", ({ world, repo }) => lint(world, repo)],
    then: ["every heuristic fired as a warning and the run has no error", (run) => {
      for (const tag of ["count", "status", "size", "layer-dup", "branch", "loaded"]) {
        expect(findings(run, tag).length, tag).toBeGreaterThan(0);
        expect(findings(run, tag).every((f) => f.sev === "warn"), tag).toBe(true);
      }
      expect(run.repos[0].findings.filter((f) => f.sev === "error")).toEqual([]);
      expect(run.machine).toEqual([]);
    }],
  });

  component("reports a symlinked, copied or lone CLAUDE.md read from trunk", {
    given: ["three repos whose trunk has a symlink, a copy and only CLAUDE.md", () => {
      const world = newWorld();
      const linked = pushedRepo(world, "linked", { "AGENTS.md": SIX_RULES, "CLAUDE.md": { link: "AGENTS.md" } });
      const copied = pushedRepo(world, "copied", { "AGENTS.md": SIX_RULES, "CLAUDE.md": SIX_RULES });
      const lone = pushedRepo(world, "lone", { "CLAUDE.md": "# Only Claude\n- one\n" });
      return { world, linked, copied, lone };
    }],
    when: ["linting the three repos", ({ world, linked, copied, lone }) => lint(world, [linked, copied, lone])],
    then: ["each is a certain error of its own kind", (run) => {
      const only = (i, tag) => run.repos[i].findings.filter((f) => f.tag === tag);
      expect(only(0, "shape")).toEqual([expect.objectContaining({ sev: "error", file: "CLAUDE.md", msg: expect.stringMatching(/symlink to AGENTS\.md/) })]);
      expect(only(1, "shape")).toEqual([expect.objectContaining({ sev: "error", msg: expect.stringMatching(/copy of AGENTS\.md/) })]);
      expect(only(2, "codex")).toEqual([expect.objectContaining({ sev: "error", msg: expect.stringMatching(/Codex reads none of these rules/) })]);
    }],
  });

  component("reports every certain class and every heuristic once on a rich repo", {
    given: ["a rich repo with dead references, a lost quote, counts, a status claim, a repeat and 33 KB", () => {
      const world = newWorld({ layers: { "lsrc/.agents/CLAUDE.md": SHARED } });
      return { world, repo: richRepo(world) };
    }],
    when: ["linting it", ({ world, repo }) => lint(world, repo)],
    then: ["the findings per check are exactly the planted ones", (run) => {
      const tally = {};
      for (const f of run.repos[0].findings) tally[`${f.tag}:${f.sev}`] = (tally[`${f.tag}:${f.sev}`] || 0) + 1;
      expect(tally).toEqual({
        "exists:error": 3, "link:error": 1, "removed:error": 1,
        "count:warn": 2, "status:warn": 1, "size:warn": 1, "layer-dup:warn": 1,
      });
      expect(findings(run, "exists").map((f) => f.line)).toEqual([2, 2, 3]);
    }],
  });

  component("errors when neither the setting nor an import loads AGENTS.md", {
    given: ["a second profile without the setting, one repo without an import and one with it", () => {
      const world = newWorld();
      writeText(join(world.profilesDir, "claude", "p2", "settings.json"), JSON.stringify({ model: "x" }));
      const plain = pushedRepo(world, "plain", { "AGENTS.md": SIX_RULES, "CLAUDE.md": "# Own rules\n- one\n- two\n- three\n" });
      const imported = pushedRepo(world, "imported", { "AGENTS.md": SIX_RULES, "CLAUDE.md": "@AGENTS.md\n" });
      return { world, plain, imported, p2: join(world.profilesDir, "claude", "p2", "settings.json") };
    }],
    when: ["linting both repos", ({ world, plain, imported }) => lint(world, [plain, imported])],
    then: ["the machine line names the profile and only the repo without an import errors", (run, { p2 }) => {
      expect(run.machine).toEqual([expect.objectContaining({
        tag: "reach", sev: "error", path: p2,
        msg: expect.stringMatching(/lacks cc-plugin-agents-md instructionFiles=claude-md-and-agents-md$/),
      })]);
      expect(findings(run, "reach")).toEqual([expect.objectContaining({ sev: "error", msg: expect.stringMatching(/^Claude does not load AGENTS\.md here/) })]);
      expect(run.repos[1].findings.filter((f) => f.tag === "reach")).toEqual([]);
    }],
  });
});

feature("rules lint command", () => {
  component("exits 1 on an error with or without --strict and 0 on warnings only", {
    given: ["one repo with a dead path and one clean repo", () => {
      const world = newWorld();
      const bad = pushedRepo(world, "bad", { "AGENTS.md": "# Rules\nSee `docs/gone.md`.\n" });
      const good = pushedRepo(world, "good");
      const imported = pushedRepo(world, "imported", { "AGENTS.md": SIX_RULES, "CLAUDE.md": "@AGENTS.md\n" });
      return { world, bad, good, imported };
    }],
    when: ["running the command for both, strict and not, and for the clean repo alone", async ({ world, bad, good, imported }) => {
      const both = await runCli(world, ["--only", "rules", bad.root, good.root]);
      const plainExit = process.exitCode; process.exitCode = 0;
      await runCli(world, ["--only", "rules", "--strict", bad.root]);
      const strictExit = process.exitCode; process.exitCode = 0;
      await runCli(world, ["--only", "rules", good.root]);
      const cleanExit = process.exitCode || 0; process.exitCode = 0;
      writeFileSync(join(world.home, ".claude", "settings.json"), "{}");
      await runCli(world, ["--only", "rules", imported.root]);
      return { both, plainExit, strictExit, cleanExit, machineExit: process.exitCode };
    }],
    then: ["errors exit 1 either way, a missing setting too, and the report shows both repos and a summary", ({ both, plainExit, strictExit, cleanExit, machineExit }, { bad }) => {
      expect([plainExit, strictExit, machineExit]).toEqual([1, 1, 1]);
      expect(cleanExit).toBe(0);
      expect(both).toContain("✗ AGENTS.md:2 `docs/gone.md` is not on origin/main [exists]");
      expect(both).toMatch(/2 repos · 1 error · \d+ warnings? · \d+\.\d s/);
      expect(both).toContain(bad.root);
    }],
  });

  component("lints a repo once when two targets are inside it", {
    given: ["one repo and two targets, its root and a subdirectory", () => {
      const world = newWorld();
      const repo = pushedRepo(world, "once", { "AGENTS.md": SIX_RULES, "docs/a.md": "a\n" });
      return { world, repo };
    }],
    when: ["running the command with both targets", ({ world, repo }) => runCli(world, ["--only", "rules", join(repo.root, "docs"), repo.root])],
    then: ["one header and a one-repo summary", (output) => {
      expect(output.match(/trunk origin\/main/g)).toHaveLength(1);
      expect(output).toMatch(/1 repo · 0 errors/);
    }],
  });

  component("skips a directory that is not a git repository", {
    given: ["a plain directory", () => {
      const world = newWorld();
      const dir = join(world.dir, "plain-dir");
      writeText(join(dir, "CLAUDE.md"), "rules\n");
      return { world, dir };
    }],
    when: ["running the command", async ({ world, dir }) => ({ output: await runCli(world, ["--only", "rules", dir]), run: lint(world, dir) })],
    then: ["one skipped line and no error", ({ output, run }) => {
      expect(run.repos[0].skipped).toBe("not a git repository");
      expect(output).toContain("not a git repository, skipped");
      expect(process.exitCode || 0).toBe(0);
    }],
  });

  component("keeps plain lint on contract and refuses unknown checks", {
    given: ["an empty plain directory", () => {
      const world = newWorld();
      const dir = join(world.dir, "empty-dir");
      writeText(join(dir, "note.txt"), "x\n");
      return { world, dir };
    }],
    when: ["running plain lint and a typo", async ({ world, dir }) => ({
      plain: await runCli(world, [dir]),
      typo: await runCli(world, ["--only", "typo"]).catch((error) => error.message),
    })],
    then: ["plain lint prints the contract report and the typo names both checks", ({ plain, typo }) => {
      expect(plain).toContain("No lint findings.");
      expect(plain).not.toContain("trunk");
      expect(typo).toMatch(/unknown check name; available: contract, rules/);
    }],
  });

  component("suppresses baselined findings and keeps other checks in the baseline file", {
    given: ["a repo with one error and a baseline that already holds a contract finding", () => {
      const world = newWorld();
      const repo = pushedRepo(world, "baselined", { "AGENTS.md": "# Rules\nSee `docs/gone.md`.\n" });
      const baseline = join(world.dir, "baseline.json");
      writeFileSync(baseline, JSON.stringify({ version: 1, findings: ["x.mjs:CONTRACT010:class A: missing WHAT: tag"] }));
      return { world, repo, baseline };
    }],
    when: ["updating the baseline and linting again against it", async ({ world, repo, baseline }) => {
      await runCli(world, ["--only", "rules", repo.root, "--baseline", baseline, "--update-baseline"]);
      process.exitCode = 0;
      const again = await runCli(world, ["--only", "rules", repo.root, "--baseline", baseline]);
      return { again, exit: process.exitCode || 0, saved: JSON.parse(readFileSync(baseline, "utf8")).findings };
    }],
    then: ["the rules finding is suppressed, counted, and the foreign key survives", ({ again, exit, saved }) => {
      expect(exit).toBe(0);
      expect(again).toMatch(/1 baselined/);
      expect(saved).toContain("x.mjs:CONTRACT010:class A: missing WHAT: tag");
      expect(saved.some((key) => /^AGENTS\.md:rules\.exists:`docs\/gone\.md` is not on origin\/main$/.test(key))).toBe(true);
    }],
  });

  unit("never truncates errors behind the limit", {
    given: ["a repo with three errors and three warnings and a limit of one", () => ({
      home: "/nowhere", machine: [], ms: 0,
      repos: [{ root: "/r", header: "/r \u00B7 trunk origin/main", skipped: null, findings: [
        ...[1, 2, 3].map((n) => ({ tag: "exists", sev: "error", file: "AGENTS.md", line: n, msg: `error ${n}` })),
        ...[4, 5, 6].map((n) => ({ tag: "count", sev: "warn", file: "AGENTS.md", line: n, msg: `warning ${n}` })),
      ] }],
    })],
    when: ["formatting with limit 1", (run) => formatRulesReport(run, { limit: 1 })],
    then: ["all errors show, one warning shows and the rest is counted", (text) => {
      expect(text.match(/\[exists\]/g)).toHaveLength(3);
      expect(text.match(/\[count\]/g)).toHaveLength(1);
      expect(text).toContain("  ... 2 more");
    }],
  });

  unit("formats the machine line, header and summary", {
    given: ["a run with one machine error, one repo with one error and one skipped directory", () => ({
      machine: [{ tag: "reach", sev: "error", path: "/home/x/.claude/settings.json", file: null, line: null,
        msg: "~/.claude/settings.json lacks cc-plugin-agents-md instructionFiles=claude-md-and-agents-md" }],
      repos: [
        { root: "/home/x/lsrc/swoop-sim", header: "~/lsrc/swoop-sim · trunk origin/main, fetched 2026-10-20 09:36 · on main, 0 behind",
          skipped: null, findings: [
            { tag: "exists", sev: "error", file: "AGENTS.md", line: 142, msg: "`tests/e2e/x.test.ts` is not on origin/master" },
            { tag: "protected", sev: "info", file: "AGENTS.md", line: null, msg: "6 protected lines, his dated words" },
          ] },
        { root: "/home/x/lsrc", header: null, skipped: "not a git repository", findings: [] },
      ],
      ms: 2400,
    })],
    when: ["formatting it", (run) => formatRulesReport(run, { home: "/nowhere" })],
    then: ["every line has the shape of the design's UX table", (text) => {
      expect(text).toContain("✗ ~/.claude/settings.json lacks cc-plugin-agents-md instructionFiles=claude-md-and-agents-md [reach]");
      expect(text).toContain("~/lsrc/swoop-sim · trunk origin/main, fetched 2026-10-20 09:36 · on main, 0 behind");
      expect(text).toContain("  ✗ AGENTS.md:142 `tests/e2e/x.test.ts` is not on origin/master [exists]");
      expect(text).toContain("  ℹ AGENTS.md: 6 protected lines, his dated words [protected]");
      expect(text).toContain("/home/x/lsrc · not a git repository, skipped");
      expect(text).toMatch(/1 repo · 2 errors · 0 warnings · 1 skipped · 2\.4 s$/);
    }],
  });
});
