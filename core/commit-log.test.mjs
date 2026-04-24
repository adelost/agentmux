import { unit, feature, expect } from "bdd-vitest";
import { execFileSync } from "child_process";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { commitsFromRepo, collectCommitsSince, reposFromAgents } from "./commit-log.mjs";

function makeRepo() {
  const dir = mkdtempSync(join(tmpdir(), "amux-commit-test-"));
  execFileSync("git", ["-C", dir, "init", "-q", "-b", "main"]);
  execFileSync("git", ["-C", dir, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", dir, "config", "user.name", "Test"]);
  execFileSync("git", ["-C", dir, "config", "commit.gpgsign", "false"]);
  return dir;
}

function commit(dir, subject, fileContent = subject, isoDate = null) {
  writeFileSync(join(dir, `f-${Date.now()}-${Math.random().toString(36).slice(2)}.txt`), fileContent);
  execFileSync("git", ["-C", dir, "add", "-A"]);
  const env = { ...process.env };
  if (isoDate) {
    env.GIT_AUTHOR_DATE = isoDate;
    env.GIT_COMMITTER_DATE = isoDate;
  }
  execFileSync("git", ["-C", dir, "commit", "-q", "-m", subject], { env });
}

feature("commitsFromRepo", () => {
  unit("returns [] for missing path", {
    given: ["a bogus path", () => ({ dir: "/tmp/does-not-exist-amux-test" })],
    when: ["querying", ({ dir }) => commitsFromRepo(dir, Date.now() - 60000)],
    then: ["empty array (graceful)", (result) => expect(result).toEqual([])],
  });

  unit("returns [] for non-git directory", {
    given: ["a tmp dir without .git", () => {
      const dir = mkdtempSync(join(tmpdir(), "amux-nogit-"));
      return { dir };
    }],
    when: ["querying", ({ dir }) => commitsFromRepo(dir, Date.now() - 60000)],
    then: ["empty array", (result, { dir }) => {
      rmSync(dir, { recursive: true, force: true });
      expect(result).toEqual([]);
    }],
  });

  unit("returns one commit with parsed fields", {
    given: ["a repo with one commit", () => {
      const dir = makeRepo();
      commit(dir, "first commit");
      return { dir };
    }],
    when: ["querying since 1h ago", ({ dir }) => commitsFromRepo(dir, Date.now() - 3600_000)],
    then: ["one row with expected shape", (result, { dir }) => {
      rmSync(dir, { recursive: true, force: true });
      expect(result.length).toBe(1);
      expect(result[0].subject).toBe("first commit");
      expect(result[0].hash).toMatch(/^[0-9a-f]{40}$/);
      expect(result[0].ts).toBeTypeOf("number");
      expect(result[0].label).toBe(result[0].repo.split("/").pop());
    }],
  });

  unit("honors --since cutoff", {
    given: ["a repo with one commit", () => {
      const dir = makeRepo();
      commit(dir, "old");
      return { dir };
    }],
    when: ["querying since 1h in future", ({ dir }) => commitsFromRepo(dir, Date.now() + 3600_000)],
    then: ["no rows", (result, { dir }) => {
      rmSync(dir, { recursive: true, force: true });
      expect(result).toEqual([]);
    }],
  });

  unit("uses custom label when provided", {
    given: ["a repo with label", () => {
      const dir = makeRepo();
      commit(dir, "labeled");
      return { dir };
    }],
    when: ["querying with label=foo", ({ dir }) => commitsFromRepo(dir, Date.now() - 3600_000, "foo")],
    then: ["label=foo on row", (result, { dir }) => {
      rmSync(dir, { recursive: true, force: true });
      expect(result[0].label).toBe("foo");
    }],
  });
});

feature("collectCommitsSince", () => {
  unit("merges and sorts across repos descending by ts", {
    given: ["two repos with commits", () => {
      const a = makeRepo();
      const b = makeRepo();
      // Explicit commit dates so ordering is deterministic (second-granularity
      // git timestamps can tie without this). Recent so the --since filter
      // doesn't drop them.
      const base = Date.now() - 60_000;
      commit(a, "a-first",  "x", new Date(base - 30_000).toISOString());
      commit(b, "b-first",  "x", new Date(base - 20_000).toISOString());
      commit(a, "a-second", "y", new Date(base - 10_000).toISOString());
      return { a, b };
    }],
    when: ["collecting", ({ a, b }) => collectCommitsSince(
      [{ repo: a, label: "alpha" }, { repo: b, label: "beta" }],
      Date.now() - 3600_000,
    )],
    then: ["3 commits descending with correct labels", (result, { a, b }) => {
      rmSync(a, { recursive: true, force: true });
      rmSync(b, { recursive: true, force: true });
      expect(result.length).toBe(3);
      expect(result[0].subject).toBe("a-second");
      expect(result[0].label).toBe("alpha");
      // Timestamps must be weakly descending
      for (let i = 1; i < result.length; i++) {
        expect(result[i - 1].ts >= result[i].ts).toBe(true);
      }
    }],
  });

  unit("de-duplicates repos with same path", {
    given: ["one repo referenced twice", () => {
      const a = makeRepo();
      commit(a, "once");
      return { a };
    }],
    when: ["collecting with duplicate entries", ({ a }) => collectCommitsSince(
      [{ repo: a, label: "x" }, { repo: a, label: "y" }],
      Date.now() - 3600_000,
    )],
    then: ["commit appears once (first entry wins)", (result, { a }) => {
      rmSync(a, { recursive: true, force: true });
      expect(result.length).toBe(1);
      expect(result[0].label).toBe("x");
    }],
  });

  unit("max caps total rows across repos", {
    given: ["repo with 5 commits", () => {
      const a = makeRepo();
      for (let i = 0; i < 5; i++) commit(a, `msg-${i}`);
      return { a };
    }],
    when: ["collecting with max=2", ({ a }) => collectCommitsSince(
      [{ repo: a }],
      Date.now() - 3600_000,
      2,
    )],
    then: ["only 2 rows returned (most recent)", (result, { a }) => {
      rmSync(a, { recursive: true, force: true });
      expect(result.length).toBe(2);
    }],
  });

  unit("ignores missing or nullish repo entries", {
    given: ["mixed repo list", () => {
      const a = makeRepo();
      commit(a, "real");
      return { a };
    }],
    when: ["collecting with null/empty mixed in", ({ a }) => collectCommitsSince(
      [null, { repo: "" }, { repo: a, label: "ok" }, undefined],
      Date.now() - 3600_000,
    )],
    then: ["only real repo contributes", (result, { a }) => {
      rmSync(a, { recursive: true, force: true });
      expect(result.length).toBe(1);
      expect(result[0].subject).toBe("real");
    }],
  });
});

feature("reposFromAgents", () => {
  unit("maps agent list to {repo,label} pairs", {
    given: ["agents with dirs", () => ({
      agents: [
        { name: "claw", dir: "/a/b" },
        { name: "api", dir: "/a/c" },
      ],
    })],
    when: ["converting", ({ agents }) => reposFromAgents(agents)],
    then: ["one entry per agent", (result) => {
      expect(result).toEqual([
        { repo: "/a/b", label: "claw" },
        { repo: "/a/c", label: "api" },
      ]);
    }],
  });

  unit("de-duplicates same dir across agents", {
    given: ["two agents sharing a dir", () => ({
      agents: [
        { name: "first", dir: "/shared" },
        { name: "second", dir: "/shared" },
      ],
    })],
    when: ["converting", ({ agents }) => reposFromAgents(agents)],
    then: ["only first is kept", (result) => {
      expect(result.length).toBe(1);
      expect(result[0].label).toBe("first");
    }],
  });

  unit("skips agents without dir", {
    given: ["mixed agents", () => ({
      agents: [{ name: "ok", dir: "/d" }, { name: "broken" }, null],
    })],
    when: ["converting", ({ agents }) => reposFromAgents(agents)],
    then: ["skips incomplete entries", (result) => {
      expect(result.length).toBe(1);
      expect(result[0].repo).toBe("/d");
    }],
  });
});
