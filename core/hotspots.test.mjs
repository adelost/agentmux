import { expect, feature, unit } from "bdd-vitest";
import {
  commitDirectories, functionChurn, parseChangedRanges, reflectionDue, touchedFunctions, verdictEntry,
} from "./hotspots.mjs";

const hot = (churn) => ({ path: "src/camera.js", name: "update", start: 10, end: 40, nloc: 30, churn, fixes: 2, history: [] });
const verdictAt = (churn) => ({ key: "src/camera.js::update", verdict: "KEEP", churn, at: "2026-09-16T10:00:00.000Z" });

feature("hotspot reflection rules", () => {
  unit("only a function that keeps changing needs a verdict, and one verdict holds until it churns again", {
    given: ["the default policy: hot at 6 trunk commits, reopen after 3 more", () => null],
    when: ["asking for functions at several churn levels", () => ({
      cold: reflectionDue(hot(5), []),
      firstTime: reflectionDue(hot(6), []),
      afterVerdict: reflectionDue(hot(8), [verdictAt(6)]),
      churnedAgain: reflectionDue(hot(9), [verdictAt(6)]),
    })],
    then: ["cold and freshly judged functions pass, new and re-churned ones are held", (due) => {
      expect(due.cold).toBeNull();
      expect(due.firstTime.reason).toBe("no verdict yet");
      expect(due.afterVerdict).toBeNull();
      expect(due.churnedAgain.reason).toBe("3 trunk commits since the KEEP verdict");
    }],
  });

  unit("a factory does not own its inner functions' lines, and a callback belongs to the function declaring it", {
    given: ["a factory with a named step holding a callback, and blame where each commit touched one of them", () => {
      const functions = [
        { path: "f.js", name: "(anonymous)", start: 1, end: 30 },
        { path: "f.js", name: "step", start: 5, end: 20 },
        { path: "f.js", name: "(anonymous)", start: 8, end: 10 },
      ];
      const blame = [{ start: 2, count: 1, sha: "setup" }, { start: 9, count: 1, sha: "callback" }, { start: 15, count: 1, sha: "body" }];
      const trunk = new Set(["setup", "callback", "body"]);
      return { functions, blame, trunk };
    }],
    when: ["measuring churn and finding who owns an edit inside the callback", ({ functions, blame, trunk }) => ({
      factory: functionChurn(functions[0], functions, blame, trunk, new Map()).churn,
      step: functionChurn(functions[1], functions, blame, trunk, new Map()).churn,
      touched: touchedFunctions(functions, new Map([["f.js", [[9, 9]]]])).map((fn) => fn.name),
    })],
    then: ["the factory keeps only its setup commit, step gets the callback and its body, the edit touches step", (result) => {
      expect(result.factory).toBe(1);
      expect(result.step).toBe(2);
      expect(result.touched).toEqual(["step"]);
    }],
  });

  unit("a change counts for the function it lands in, including an added line inside it", {
    given: ["two functions and a diff that edits one, inserts into the other and edits a line between them", () => ({
      functions: [
        { path: "src/a.js", name: "first", start: 1, end: 10 },
        { path: "src/a.js", name: "second", start: 20, end: 30 },
        { path: "src/a.js", name: "third", start: 40, end: 50 },
      ],
      diff: ["--- a/src/a.js", "+++ b/src/a.js", "@@ -5,2 +5,3 @@", "@@ -15 +16 @@", "@@ -25,0 +27,2 @@"].join("\n"),
    })],
    when: ["finding touched functions", ({ functions, diff }) => touchedFunctions(functions, parseChangedRanges(diff))],
    then: ["first and second are touched, third is not", (touched) => {
      expect(touched.map((fn) => fn.name)).toEqual(["first", "second"]);
    }],
  });

  unit("the hook finds where each git commit runs and ignores plumbing", {
    given: ["a pane cwd and a home directory", () => ({ cwd: "/work/pane", home: "/home/me" })],
    when: ["reading several shell commands", ({ cwd, home }) => ({
      cdChain: commitDirectories('cd ~/lsrc/game && git add src/a.js && git commit -m "fix: x"', cwd, home),
      dashC: commitDirectories("git -C /repos/app commit -m wip", cwd, home),
      plain: commitDirectories("git commit --amend --no-edit", cwd, home),
      plumbing: commitDirectories("git commit-tree HEAD^{tree} -m x", cwd, home),
      unrelated: commitDirectories("git status && npm test", cwd, home),
    })],
    then: ["commits resolve to their directories, the rest to nothing", (dirs) => {
      expect(dirs.cdChain).toEqual(["/home/me/lsrc/game"]);
      expect(dirs.dashC).toEqual(["/repos/app"]);
      expect(dirs.plain).toEqual(["/work/pane"]);
      expect(dirs.plumbing).toEqual([]);
      expect(dirs.unrelated).toEqual([]);
    }],
  });

  unit("a verdict must name a known decision and a reason, because the ledger is later measured", {
    given: ["a hot function", () => hot(7)],
    when: ["recording verdicts", (hotspot) => ({
      valid: verdictEntry({ hotspot, verdict: "split", reason: "fixes came from the duplicated fpv predicate", repo: "r", headSha: "abc" }),
      unknown: () => verdictEntry({ hotspot, verdict: "LATER", reason: "not now, maybe next sprint", repo: "r", headSha: "abc" }),
      silent: () => verdictEntry({ hotspot, verdict: "KEEP", reason: "ok", repo: "r", headSha: "abc" }),
    })],
    then: ["the valid one is normalized, the others refuse", (result) => {
      expect(result.valid).toMatchObject({ key: "src/camera.js::update", verdict: "SPLIT", churn: 7 });
      expect(result.unknown).toThrow(/REWRITE, SPLIT, KEEP/u);
      expect(result.silent).toThrow(/one sentence/u);
    }],
  });
});
