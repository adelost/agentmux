import { expect, feature, integration } from "bdd-vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import { readStateAgeSnapshot, replayStateAge, stateAgeRows } from "./state-age-history.mjs";

feature("state-age history uses the actual remote-default line", () => {
  integration("uncommitted edits cannot refresh the clock and hourly replay sends nothing", {
    given: ["a real Git history with an old row and a later checkpoint", () => {
      const root = mkdtempSync(join(tmpdir(), "state-age-history-"));
      const git = (args, stamp = null) => execFileSync("git", ["-C", root, ...args], {
        encoding: "utf8", env: { ...process.env, ...(stamp ? { GIT_AUTHOR_DATE: stamp, GIT_COMMITTER_DATE: stamp } : {}) },
        stdio: ["ignore", "pipe", "pipe"],
      }).trim();
      git(["init", "-b", "main"]); git(["config", "user.email", "test@example.invalid"]); git(["config", "user.name", "Test"]);
      mkdirSync(join(root, "docs"));
      const header = "| # | Prio | Task | Owner | State |\n";
      const base = header + "| 533c | P1 | remove generations | claw:6 | Done |\n| 557a | P1 | local ingress | lsrc:3 staffs | open |\n";
      writeFileSync(join(root, "docs/TASKS.md"), base); git(["add", "."]); git(["commit", "-m", "baseline"], "2026-10-25T00:24:00Z");
      writeFileSync(join(root, "docs/TASKS.md"), base.replace("Done |", "working checkpoint |"));
      git(["commit", "-am", "checkpoint"], "2026-10-26T09:24:00Z");
      const tip = git(["rev-parse", "HEAD"]); git(["update-ref", "refs/remotes/origin/main", tip]);
      git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
      writeFileSync(join(root, "docs/TASKS.md"), base.replace("working", "Done"));
      return { root, tip, project: { id: "cutkit", root, ledger: "docs/TASKS.md", dispatcher: "lsrc:3", panes: [] } };
    }],
    when: ["reading and replaying remote history", f => ({ ...f,
      snapshot: readStateAgeSnapshot(f.project, f.tip),
      replay: replayStateAge(f.project, { since: Date.parse("2026-10-26T00:24:00Z"), until: Date.parse("2026-10-27T09:24:00Z") }),
    })],
    then: ["the actual checkpoint time and both required alarms survive", ({ snapshot, replay }) => {
      expect(snapshot.rows[0].changedAt).toBe(Date.parse("2026-10-26T09:24:00Z"));
      expect(replay.firstFlags["533c"]).toBe("2026-10-27T09:24:00.000Z");
      expect(replay.firstFlags["557a"]).toBe("2026-10-26T00:24:00.000Z");
      expect(replay.days["2026-10-26"].messages).toBe(1);
      expect(replay.days["2026-10-27"].messages).toBe(3);
      expect(replay.paneHistoryAvailable).toBe(false); expect(replay.eligible).toBe(false);
      expect(stateAgeRows("| # | Task | Owner | State |\n| 1 | A | claw:6 | open |")[0].priority).toBe("P1");
    }],
    cleanup: ({ root }) => rmSync(root, { recursive: true, force: true }),
  });
});
