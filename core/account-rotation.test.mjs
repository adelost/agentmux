import { expect, feature, unit } from "bdd-vitest";
import { accountRotationOutcome, classifyClaudeRotationPane, claudeStartAnswerKeys, claudeStartDialog } from "./account-rotation.mjs";

feature("Claude account rotation policy", () => {
  unit("a sleeping pane changes selection without being woken", {
    when: ["classifying a shell-only Claude pane", () => classifyClaudeRotationPane({
      processState: { command: "bash", shell: true, running: false },
      liveDeliveryJobs: 0,
    })],
    then: ["the pane is dormant and safe", (result) => {
      expect(result).toEqual({ allow: true, mode: "dormant", reason: "pane-sleeping" });
    }],
  });

  unit("a submitted delivery blocks even a sleeping pane", {
    when: ["classifying a shell with a live delivery", () => classifyClaudeRotationPane({
      processState: { command: "bash", shell: true, running: false },
      liveDeliveryJobs: 1,
    })],
    then: ["the profile cannot change before the delivery settles", result => {
      expect(result).toEqual({ allow: false, mode: "blocked", reason: "live-or-unknown-delivery" });
    }],
  });

  unit("active work or queued delivery blocks the whole transition", {
    when: ["classifying both unsafe states", () => [
      classifyClaudeRotationPane({
        processState: { command: "claude", running: true },
        busy: true,
        transportState: "empty-idle",
        liveDeliveryJobs: 0,
        sessionId: "session",
      }),
      classifyClaudeRotationPane({
        processState: { command: "claude", running: true },
        busy: false,
        transportState: "empty-idle",
        liveDeliveryJobs: 1,
        sessionId: "session",
      }),
    ]],
    then: ["neither pane is eligible", (results) => {
      expect(results.map((result) => result.reason)).toEqual([
        "active-or-unknown-turn",
        "live-or-unknown-delivery",
      ]);
    }],
  });

  unit("a rollback is reported as partial rather than recovered", {
    when: ["one pane rolls back after restart failure", () => accountRotationOutcome([
      { key: "lsrc:0", status: "switched" },
      { key: "lsrc:1", status: "rolled-back" },
    ])],
    then: ["the fleet result remains honest", (result) => {
      expect(result.status).toBe("PARTIAL");
    }],
  });

  unit("an untouched busy project and a switched project are partial", {
    when: ["classifying both project outcomes", () => accountRotationOutcome([
      { key: "skydive:0", status: "blocked", reason: "delivery-lease-busy:skydive" },
      { key: "lsrc:0", status: "selected-for-next-wake" },
    ])],
    then: ["the fleet is not called recovered", result => {
      expect(result.status).toBe("PARTIAL");
    }],
  });
});

// 3 Nov 2026: Claude Code 2.1.312 saves the start answers under the git root and asks the imports question only when a
// CLAUDE.md imports a file from outside the pane directory. The dry run held all 22 panes for Claude S, 16 of them for a
// question that never came, because it read the pane directory and trusted the source profile's old approval.
feature("Claude start questions", () => {
  const cwd = "/work/proj/.agents/0", root = "/work/proj";
  const gitAtRoot = dir => dir === root;
  const outside = () => [{ path: "/work/proj/AGENTS.md", from: "/work/proj/CLAUDE.md" }];
  const profile = projects => ({ identityPath: JSON.stringify({ projects }) });
  const readJson = path => JSON.parse(path);
  const ask = (projects, externalImports = outside, hasGitEntry = gitAtRoot) =>
    claudeStartDialog({ target: profile(projects), cwd, readJson, hasGitEntry, externalImports });
  const approved = { hasClaudeMdExternalIncludesApproved: true, hasClaudeMdExternalIncludesWarningShown: true };

  unit("a project nobody answered, whose CLAUDE.md imports an outside file, is held", {
    when: ["asking for the target with no answers", () => ask({})],
    then: ["the question is named", result => { expect(result).toBe("external-claude-md-imports"); }],
  });

  unit("an answer saved under the git root settles the question for every pane directory below it", {
    when: ["asking for a target that answered at the root", () => ask({ [root]: approved })],
    then: ["nothing is held", result => { expect(result).toBeNull(); }],
  });

  unit("a declined question counts as answered", {
    when: ["asking for a target that was shown the question and said no", () =>
      ask({ [root]: { hasClaudeMdExternalIncludesApproved: false, hasClaudeMdExternalIncludesWarningShown: true } })],
    then: ["claude does not ask again, so nothing is held", result => { expect(result).toBeNull(); }],
  });

  unit("an answer saved under the pane directory, as older claude did, still counts", {
    when: ["asking for a target with the answer on the pane directory", () => ask({ [cwd]: approved })],
    then: ["nothing is held", result => { expect(result).toBeNull(); }],
  });

  unit("an answer under another project settles nothing", {
    when: ["asking for a target that answered a sibling project", () => ask({ "/work/other": approved })],
    then: ["the question is still named", result => { expect(result).toBe("external-claude-md-imports"); }],
  });

  unit("no outside import means no question, answered or not", {
    when: ["asking where the CLAUDE.md files import nothing from outside", () => ask({}, () => [])],
    then: ["nothing is held", result => { expect(result).toBeNull(); }],
  });

  unit("the answer keys are the pane directory and the git root, or the directory alone outside a repository", {
    when: ["listing both", () => [claudeStartAnswerKeys(cwd, gitAtRoot), claudeStartAnswerKeys(cwd, () => false), claudeStartAnswerKeys(root, gitAtRoot)]],
    then: ["a repository adds its root once", keys => {
      expect(keys).toEqual([[cwd, root], [cwd], [root]]);
    }],
  });
});
