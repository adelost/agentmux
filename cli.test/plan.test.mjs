import { feature, unit, expect } from "bdd-vitest";
import { buildPlanPrompt, validatePlan, parsePlan, buildWaves, buildTaskPrompt } from "../cli/plan.mjs";
import { mkdtempSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

const SAMPLE_PLAN = `# Plan
## Goal
Refactor auth

### Task 1
**Files:** src/auth.ts
**Depends on:** (none)
**Spec:** Rewrite auth module
**Acceptance:** Tests pass

### Task 2
**Files:** src/routes.ts
**Depends on:** Task 1
**Spec:** Update routes to use new auth
**Acceptance:** Routes work

### Task 3
**Files:** src/tests.ts
**Depends on:** Task 1, 2
**Spec:** Add integration tests
**Acceptance:** All tests green
`;

feature("buildPlanPrompt", () => {
  unit("includes goal in prompt", {
    given: ["a goal", () => "Refactor the auth system"],
    when: ["building prompt", buildPlanPrompt],
    then: ["contains goal text", (prompt) => {
      expect(prompt).toContain("Refactor the auth system");
      expect(prompt).toContain("AGENT_PLAN.md");
    }],
  });
});

feature("validatePlan", () => {
  unit("valid plan passes", {
    given: ["a temp plan file", () => {
      const dir = mkdtempSync(join(tmpdir(), "plan-test-"));
      const path = join(dir, "AGENT_PLAN.md");
      writeFileSync(path, SAMPLE_PLAN);
      return { path, dir };
    }],
    when: ["validating", ({ path }) => validatePlan(path)],
    then: ["returns true", (result, { dir }) => {
      expect(result).toBe(true);
      rmSync(dir, { recursive: true });
    }],
  });

  unit("rejects template with placeholders", {
    given: ["a plan with template placeholders", () => {
      const dir = mkdtempSync(join(tmpdir(), "plan-test-"));
      const path = join(dir, "AGENT_PLAN.md");
      writeFileSync(path, "### Task 1\n[Vad vi vill]\nfil1.py");
      return { path, dir };
    }],
    when: ["validating", ({ path }) => validatePlan(path)],
    then: ["returns false", (result, { dir }) => {
      expect(result).toBe(false);
      rmSync(dir, { recursive: true });
    }],
  });

  unit("rejects missing file", {
    given: ["nonexistent path", () => "/tmp/nonexistent-plan-test.md"],
    when: ["validating", validatePlan],
    then: ["returns false", (result) => expect(result).toBe(false)],
  });
});

feature("parsePlan", () => {
  unit("extracts task count and dependencies", {
    given: ["sample plan content", () => SAMPLE_PLAN],
    when: ["parsing", parsePlan],
    then: ["3 tasks with correct deps", ({ taskCount, dependsOn }) => {
      expect(taskCount).toBe(3);
      expect(dependsOn.get(1)).toEqual([]);
      expect(dependsOn.get(2)).toEqual([1]);
      expect(dependsOn.get(3)).toEqual([1, 2]);
    }],
  });
});

feature("buildWaves", () => {
  unit("creates correct execution waves", {
    given: ["3 tasks: 1 independent, 2 depends on 1, 3 depends on 1+2", () => {
      const dependsOn = new Map([[1, []], [2, [1]], [3, [1, 2]]]);
      return { taskCount: 3, dependsOn };
    }],
    when: ["building waves", ({ taskCount, dependsOn }) => buildWaves(taskCount, dependsOn)],
    then: ["3 sequential waves", (waves) => {
      expect(waves).toEqual([[1], [2], [3]]);
    }],
  });

  unit("parallel tasks in same wave", {
    given: ["3 independent tasks", () => {
      const dependsOn = new Map([[1, []], [2, []], [3, []]]);
      return { taskCount: 3, dependsOn };
    }],
    when: ["building waves", ({ taskCount, dependsOn }) => buildWaves(taskCount, dependsOn)],
    then: ["all in one wave", (waves) => {
      expect(waves).toHaveLength(1);
      expect(waves[0]).toEqual([1, 2, 3]);
    }],
  });

  unit("detects circular dependencies", {
    given: ["circular deps", () => {
      const dependsOn = new Map([[1, [2]], [2, [1]]]);
      return { taskCount: 2, dependsOn };
    }],
    when: ["building waves", ({ taskCount, dependsOn }) => () => buildWaves(taskCount, dependsOn)],
    then: ["throws", (fn) => expect(fn).toThrow("Circular dependency")],
  });
});

feature("buildTaskPrompt", () => {
  unit("includes task section in prompt", {
    given: ["plan content and task number", () => ({ num: 2, content: SAMPLE_PLAN })],
    when: ["building prompt", ({ num, content }) => buildTaskPrompt(num, content)],
    then: ["contains task 2 spec", (prompt) => {
      expect(prompt).toContain("Task 2");
      expect(prompt).toContain("Update routes");
      expect(prompt).not.toContain("Add integration tests"); // task 3
    }],
  });
});
