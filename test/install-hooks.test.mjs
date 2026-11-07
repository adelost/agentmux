import { expect, feature, integration } from "bdd-vitest";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, readlinkSync, rmSync, writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, statSync } from "node:fs";
import { publishLedger, updateLedgerMirror } from "../core/work-ledger-write.mjs";
import { it } from "vitest";

const git = (repo, ...args) => {
  const result = spawnSync("git", ["-C", repo, ...args], { encoding: "utf8" });
  if (result.status) throw new Error(result.stderr);
  return result.stdout.trim();
};

it("publishes without touching a dirty ledger or another staged file and alarms on the blocked mirror", () => {
  const root = mkdtempSync(join(tmpdir(), "amux-ledger-write-")), repo = join(root, "mirror"), remote = join(root, "origin.git");
  try {
    mkdirSync(repo); mkdirSync(join(repo, "docs")); git(root, "init", "--bare", remote); git(repo, "init", "-b", "master");
    git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(repo, "docs/TASKS.md"), "| 1 | open |\n| 2 | open |\n");
    writeFileSync(join(repo, "code.txt"), "code\n"); git(repo, "add", "."); git(repo, "commit", "-m", "initial");
    git(repo, "remote", "add", "origin", remote); git(repo, "push", "-u", "origin", "master");
    writeFileSync(join(repo, "code.txt"), "staged unrelated\n"); git(repo, "add", "code.txt");
    writeFileSync(join(repo, "docs/TASKS.md"), "| 1 | uncommitted |\n| 2 | open |\n");
    const index = git(repo, "diff", "--cached"), alarms = [];
    const result = publishLedger({ repo, path: "docs/TASKS.md", branch: "master", subject: "row 2", alarm: m => alarms.push(m),
      command: [process.execPath, "--input-type=module", "-e", "let s='';for await(const c of process.stdin)s+=c;process.stdout.write(s.replace('| 2 | open |','| 2 | done |'))"] });
    expect(result.published).toBe(true); expect(result.ok).toBe(false);
    expect(git(repo, "show", "origin/master:docs/TASKS.md")).toContain("| 2 | done |");
    expect(readFileSync(join(repo, "docs/TASKS.md"), "utf8")).toContain("uncommitted");
    expect(git(repo, "diff", "--cached")).toBe(index);
    expect(alarms).toHaveLength(1); expect(alarms[0]).toContain("docs/TASKS.md");
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("publishes from a linked branch without treating it as a shared mirror", () => {
  const root = mkdtempSync(join(tmpdir(), "amux-ledger-branch-")), repo = join(root, "mirror"), work = join(root, "work");
  try {
    mkdirSync(repo); mkdirSync(join(repo, "docs")); git(root, "init", "--bare", "origin.git"); git(repo, "init", "-b", "master");
    git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "fixture@example.invalid");
    writeFileSync(join(repo, "docs/TASKS.md"), "| 1 | open |\n"); git(repo, "add", "."); git(repo, "commit", "-m", "initial");
    git(repo, "remote", "add", "origin", join(root, "origin.git")); git(repo, "push", "origin", "master");
    git(repo, "worktree", "add", "-b", "fix/timeline", work);
    const before = git(work, "rev-parse", "HEAD"), alarms = [];
    const result = publishLedger({ repo: work, path: "docs/TASKS.md", branch: "master", subject: "row 1", alarm: m => alarms.push(m),
      command: [process.execPath, "-e", "process.stdin.on('data',d=>process.stdout.write(d.toString().replace('open','done')))"] });
    expect(result.published).toBe(true); expect(result.ok).toBe(true); expect(alarms).toEqual([]);
    expect(git(work, "rev-parse", "HEAD")).toBe(before);
    expect(readFileSync(join(work, "docs/TASKS.md"), "utf8")).toContain("open");
    expect(git(repo, "show", "origin/master:docs/TASKS.md")).toContain("done");
    expect(updateLedgerMirror(repo, "master", { alarm: m => alarms.push(m) }).ok).toBe(true);
    expect(git(repo, "rev-parse", "HEAD")).toBe(result.sha);
    expect(readFileSync(join(repo, "docs/TASKS.md"), "utf8")).toContain("done"); expect(alarms).toEqual([]);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("uses the same publisher for a backup script and preserves its executable mode", () => {
  const root = mkdtempSync(join(tmpdir(), "amux-ledger-source-")), repo = join(root, "mirror");
  try {
    mkdirSync(repo); git(root, "init", "--bare", "origin.git"); git(repo, "init", "-b", "master");
    git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "f@example.invalid");
    writeFileSync(join(repo, "backup.sh"), "#!/bin/sh\necho before\n"); chmodSync(join(repo, "backup.sh"), 0o755);
    git(repo, "add", "."); git(repo, "commit", "-m", "initial"); git(repo, "remote", "add", "origin", join(root, "origin.git")); git(repo, "push", "origin", "master");
    const alarms = [];
    const result = publishLedger({ repo, path: "backup.sh", file: true, branch: "master", subject: "backup fix", alarm: m => alarms.push(m),
      command: [process.execPath, "-e", "process.stdin.on('data',d=>process.stdout.write(d.toString().replace('before','after')))"] });
    expect(result.ok).toBe(true); expect(alarms).toEqual([]);
    expect(readFileSync(join(repo, "backup.sh"), "utf8")).toContain("echo after");
    expect(statSync(join(repo, "backup.sh")).mode & 0o111).toBe(0o111);
    expect(git(repo, "ls-tree", "HEAD", "backup.sh")).toMatch(/^100755 /);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("alarms without merging when the mirror has diverged", () => {
  const root = mkdtempSync(join(tmpdir(), "amux-ledger-diverged-"));
  try {
    git(root, "init", "-b", "master"); mkdirSync(join(root, "docs")); git(root, "config", "user.name", "Fixture"); git(root, "config", "user.email", "f@example.invalid");
    writeFileSync(join(root, "docs/TASKS.md"), "| 1 | open |\n"); git(root, "add", "."); git(root, "commit", "-m", "initial");
    git(root, "init", "--bare", "origin.git"); git(root, "remote", "add", "origin", join(root, "origin.git"));
    writeFileSync(join(root, ".git", "info", "exclude"), "origin.git/\n");
    git(root, "checkout", "-b", "other"); writeFileSync(join(root, "remote.txt"), "remote"); git(root, "add", "."); git(root, "commit", "-m", "remote");
    git(root, "push", "origin", "HEAD:master"); git(root, "checkout", "master");
    writeFileSync(join(root, "local.txt"), "local"); git(root, "add", "."); git(root, "commit", "-m", "local");
    const before = git(root, "rev-parse", "HEAD"), alarms = [];
    expect(updateLedgerMirror(root, "master", { alarm: m => alarms.push(m) }).ok).toBe(false);
    expect(git(root, "rev-parse", "HEAD")).toBe(before); expect(alarms).toHaveLength(1);
    expect(alarms[0]).toMatch(/fast-forward/);
  } finally { rmSync(root, { recursive: true, force: true }); }
});

it("keeps both simultaneous generated rows on origin and fast-forwards their mirror", async () => {
  const root = mkdtempSync(join(tmpdir(), "amux-ledger-concurrent-")), repo = join(root, "mirror");
  try {
    mkdirSync(repo); mkdirSync(join(repo, "docs")); git(root, "init", "--bare", "origin.git"); git(repo, "init", "-b", "master");
    git(repo, "config", "user.name", "Fixture"); git(repo, "config", "user.email", "f@example.invalid");
    writeFileSync(join(repo, "docs/TASKS.md"), "| 1 | open |\n| 2 | open |\n");
    git(repo, "add", "."); git(repo, "commit", "-m", "initial");
    git(repo, "remote", "add", "origin", join(root, "origin.git")); git(repo, "push", "-u", "origin", "master");
    const run = row => new Promise(resolveResult => {
      const generator = `let s='';for await(const c of process.stdin)s+=c;await new Promise(r=>setTimeout(r,150));process.stdout.write(s.replace('| ${row} | open |','| ${row} | done |'));`;
      const entry = `import {publishLedger} from ${JSON.stringify(new URL("../core/work-ledger-write.mjs", import.meta.url).href)};try{console.log(JSON.stringify(publishLedger({repo:${JSON.stringify(repo)},path:'docs/TASKS.md',branch:'master',subject:'row ${row}',command:${JSON.stringify([process.execPath, "--input-type=module", "-e", generator])},alarm:m=>console.error('STUB ALARM: '+m)})))}catch(e){console.error(e.message);process.exitCode=1}`;
      const child = spawn(process.execPath, ["--input-type=module", "-e", entry]);
      let out = ""; child.stdout.on("data", d => out += d); child.stderr.on("data", d => out += d);
      child.on("close", code => resolveResult({ code, out }));
    });
    const results = await Promise.all([run(1), run(2)]);
    expect(results.map(r => r.code), JSON.stringify(results)).toEqual([0, 0]);
    expect(readFileSync(join(repo, "docs/TASKS.md"), "utf8")).toBe("| 1 | done |\n| 2 | done |\n");
    expect(git(repo, "rev-parse", "HEAD")).toBe(git(repo, "rev-parse", "origin/master"));
    expect(git(repo, "rev-list", "--count", "HEAD")).toBe("3");
  } finally { rmSync(root, { recursive: true, force: true }); }
}, 15_000);

feature("agentmux hook installer", () => {
  integration("creates the Claude settings directory in a clean non-Claude home", {
    given: ["an empty home", () => mkdtempSync(join(tmpdir(), "amux-install-hooks-clean-"))],
    when: ["installing shared hooks", (home) => ({
      home,
      result: spawnSync(process.execPath, [resolve("bin/install-hooks.mjs")], {
        encoding: "utf8",
        env: { ...process.env, HOME: home },
      }),
    })],
    then: ["installation succeeds without a pre-existing Claude directory", ({ home, result }) => {
      expect(result.status, result.stderr).toBe(0);
      expect(existsSync(join(home, ".claude", "settings.json"))).toBe(true);
      rmSync(home, { recursive: true, force: true });
    }],
  });

  integration("installs one blocking Suggestions authoring guard without removing other hooks", {
    given: ["a settings file with an unrelated Bash hook and a stale amux guard", () => {
      const home = mkdtempSync(join(tmpdir(), "amux-install-hooks-"));
      const claude = join(home, ".claude");
      mkdirSync(claude, { recursive: true });
      writeFileSync(join(claude, "settings.json"), `${JSON.stringify({ hooks: {
        PreToolUse: [
          { matcher: "Bash", hooks: [{ type: "command", command: "keep-me" }] },
          { matcher: "Bash", hooks: [{ type: "command",
            command: "node /stale/suggestions-write-guard.mjs" }] },
        ],
      } }, null, 2)}\n`);
      return home;
    }],
    when: ["installing the hook update twice", (home) => ({
      home,
      results: [0, 1].map(() => spawnSync(
        process.execPath,
        [resolve("bin/install-hooks.mjs")],
        { encoding: "utf8", env: { ...process.env, HOME: home } },
      )),
    })],
    then: ["the guard is singular, stable, and the existing hook survives", ({ home, results }) => {
      expect(results.map((result) => result.status)).toEqual([0, 0]);
      const settings = JSON.parse(readFileSync(join(home, ".claude", "settings.json"), "utf8"));
      const commands = settings.hooks.PreToolUse.flatMap((row) => row.hooks)
        .map((hook) => hook.command);
      expect(commands).toContain("keep-me");
      expect(commands.filter((command) => command.includes("suggestions-write-guard.mjs")))
        .toHaveLength(1);
      expect(settings.hooks.PreToolUse.find((row) => row.hooks.some(
        (hook) => hook.command.includes("suggestions-write-guard.mjs"),
      )).matcher).toBe("Bash");
      expect(commands.filter((command) => command.includes("hotspot-commit-guard.mjs"))).toHaveLength(1);
      // 2026-09-29: rm targets Claude Code stops for a person are refused before the call, once per install
      expect(commands.filter((command) => command.includes("rm-target-guard.mjs"))).toHaveLength(1);
      // 2026-10-10: forks are banned (Mattias: "vi borde väl förbjuda det helt"), by Claude Code's own switch and
      // by a guard that names the fresh-subagent alternative, once per install
      expect(settings.env.CLAUDE_CODE_FORK_SUBAGENT).toBe("0");
      const forkGuards = settings.hooks.PreToolUse.filter((row) => row.hooks.some(
        (hook) => hook.command.includes("fork-guard.mjs"),
      ));
      expect(forkGuards.map((row) => row.matcher)).toEqual(["Agent|Task"]);
      for (const event of ["SubagentStart", "SubagentStop", "PostToolUseFailure", "PostToolUse", "SessionStart"]) {
        expect(settings.hooks[event].filter(row => row.hooks.some(hook => hook.command.includes("fork-guard.mjs"))))
          .toHaveLength(1);
      }
      // 2026-10-20: TaskStop ends an agent without a SubagentStop, so the guard reads its receipt (lsrc:0)
      expect(settings.hooks.PostToolUse.filter(row => row.hooks.some(hook => hook.command.includes("fork-guard.mjs")))
        .map(row => row.matcher)).toEqual(["Agent|Task|TaskStop"]);
      // 2026-10-10: the daily memory section rule reaches the writer while writing, once per install
      const reminders = settings.hooks.PostToolUse.filter((row) => row.hooks.some(
        (hook) => hook.command.includes("memory-section-reminder.mjs"),
      ));
      expect(reminders).toHaveLength(1);
      expect(reminders[0].matcher).toBe("Write|Edit|MultiEdit|Bash");
      expect(reminders[0].hooks[0].command).toContain("*memory/MEMORY.md*");
      const installed = join(home, ".agentmux", "bin", "amux-suggest.mjs");
      const linked = join(home, ".local", "bin", "amux-suggest");
      expect(existsSync(installed)).toBe(true);
      expect(resolve(join(linked, ".."), readlinkSync(linked))).toBe(installed);
      rmSync(home, { recursive: true, force: true });
    }],
  });
});
