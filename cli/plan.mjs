// Plan creation + dispatch. Creates AGENT_PLAN.md then dispatches tasks in waves.
// Replaces dispatch.sh + inline plan logic in bash agent script.

import { spawn } from "child_process";
import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { runOneshot } from "./run.mjs";
import { createEventLogger } from "./events.mjs";
import { sendToChannel, sendToSession } from "./send-notify.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const CLAUDE_FLAGS = "--dangerously-skip-permissions";
const MAX_PLAN_RETRIES = 2;

/** Build the prompt that tells Claude to create a plan. */
export function buildPlanPrompt(goal) {
  return `Read the codebase, then WRITE the file AGENT_PLAN.md (overwrite the existing template) with a concrete plan.

Goal: ${goal}

The plan must have:
- Goal (one sentence)
- Context (architecture, coding standards)
- 2-3 Tasks, each with: Files (exact paths), Depends on, Spec (detailed), Acceptance criteria
- No two tasks touch the same files
- Constraints section

DO NOT just describe the plan in chat. You MUST use the Write tool to write AGENT_PLAN.md to disk.
DO NOT implement any tasks — only write the plan file.
Write in Swedish. Be detailed in Spec so agents don't need to guess.`;
}

/** Validate that a plan file looks real (not template). */
export function validatePlan(planPath) {
  if (!existsSync(planPath)) return false;
  const content = readFileSync(planPath, "utf-8");
  if (!content.includes("### Task")) return false;
  // Reject template placeholders
  if (/fil1\.py|fil3\.py|\[Vad vi vill\]|\[setup\/infra\]|\[Detaljerad/.test(content)) return false;
  return true;
}

/** Parse task count and dependencies from plan. */
export function parsePlan(planContent) {
  const taskHeaders = planContent.match(/^### Task \d+/gm) || [];
  const taskCount = taskHeaders.length;
  const dependsOn = new Map();

  for (let i = 1; i <= taskCount; i++) {
    const section = extractTaskSection(planContent, i);
    const depMatch = section.match(/\*{0,2}Depends on:?\*{0,2}[:\s]*(?:Task\s*)?(\d+(?:\s*,\s*\d+)*)/i);
    if (depMatch) {
      dependsOn.set(i, depMatch[1].split(",").map((s) => parseInt(s.trim())));
    } else {
      dependsOn.set(i, []);
    }
  }

  return { taskCount, dependsOn };
}

/** Build execution waves from dependency graph (topological sort). */
export function buildWaves(taskCount, dependsOn) {
  const waves = [];
  const done = new Set();

  while (done.size < taskCount) {
    const wave = [];
    for (let i = 1; i <= taskCount; i++) {
      if (done.has(i)) continue;
      const deps = dependsOn.get(i) || [];
      if (deps.every((d) => done.has(d))) wave.push(i);
    }
    if (!wave.length) throw new Error("Circular dependency in plan");
    waves.push(wave);
    wave.forEach((t) => done.add(t));
  }

  return waves;
}

/** Extract a single task section from plan content. */
function extractTaskSection(content, taskNum) {
  const pattern = new RegExp(`### Task ${taskNum}[\\s\\S]*?(?=### Task \\d+|$)`);
  const match = content.match(pattern);
  return match ? match[0] : "";
}

/** Build prompt for dispatching a single task. */
export function buildTaskPrompt(taskNum, planContent) {
  const section = extractTaskSection(planContent, taskNum);
  return `You are executing Task ${taskNum} from AGENT_PLAN.md.

Here is your task:

${section}

Instructions:
- Read the full plan file AGENT_PLAN.md first for context
- Implement ONLY this task — do not touch files assigned to other tasks
- Follow the project's coding standards (check CLAUDE.md)
- Write tests if the acceptance criteria mention them
- Commit your changes when done with a descriptive message
- If something is unclear, make your best judgment and note it`;
}

/** Create plan via claude -p. */
export async function createPlan({ dir, goal, model, planPath }) {
  const prompt = buildPlanPrompt(goal);

  for (let attempt = 1; attempt <= MAX_PLAN_RETRIES; attempt++) {
    console.log(`📋 Creating plan (attempt ${attempt}/${MAX_PLAN_RETRIES})...`);

    const args = ["-p", CLAUDE_FLAGS];
    if (model) args.push("--model", model);

    const child = spawn("claude", args, { cwd: dir, timeout: 300000, env: process.env });
    child.stdin.write(prompt);
    child.stdin.end();

    await new Promise((resolve) => child.on("close", resolve));

    if (validatePlan(planPath)) {
      console.log(`✅ Plan ready: ${planPath}`);
      return true;
    }

    if (attempt < MAX_PLAN_RETRIES) {
      console.log("⚠️ Plan still template, retrying...");
    }
  }

  throw new Error(`Plan creation failed after ${MAX_PLAN_RETRIES} attempts`);
}

/** Execute full plan: create plan, parse deps, dispatch in waves. */
export async function executePlan({ dir, goal, timeout, notifyChannel, msgSession, model, planOnly, dispatchOnly, fg }) {
  const planPath = join(dir, "AGENT_PLAN.md");
  const notify = buildNotifier(notifyChannel, msgSession);
  const log = createEventLogger({ notify });

  // Phase 1: Create plan (unless dispatch-only)
  if (!dispatchOnly) {
    await createPlan({ dir, goal, model, planPath });
    if (planOnly) {
      console.log(`\n📋 Plan created. Review: ${planPath}`);
      console.log(`   Dispatch: agent plan ${dir} -d`);
      return;
    }
  }

  // Phase 2: Dispatch
  if (!existsSync(planPath)) throw new Error(`No AGENT_PLAN.md in ${dir}`);
  const planContent = readFileSync(planPath, "utf-8");
  const { taskCount, dependsOn } = parsePlan(planContent);
  const waves = buildWaves(taskCount, dependsOn);

  console.log(`\n📋 Dispatching ${taskCount} tasks in ${waves.length} wave(s)...`);
  log("📋", "plan", 0, "DISPATCH", `${taskCount} tasks, ${waves.length} waves`);

  for (let w = 0; w < waves.length; w++) {
    const wave = waves[w];
    console.log(`\n🌊 Wave ${w + 1}: Tasks ${wave.join(", ")}`);

    const results = await Promise.all(
      wave.map((taskNum) => {
        const prompt = buildTaskPrompt(taskNum, planContent);
        return runOneshot({
          dir,
          prompt,
          timeout,
          notifyChannel,
          msgSession,
          model,
          fg: true,
        }).then((r) => ({ taskNum, ...r }));
      }),
    );

    for (const r of results) {
      const icon = r.exitCode === 0 ? "✅" : "❌";
      console.log(`  ${icon} Task ${r.taskNum}: ${r.elapsed}s, ${r.toolCount} tools`);
      if (r.exitCode !== 0) {
        log("❌", "plan", 0, "TASK_FAILED", `Task ${r.taskNum} failed (exit ${r.exitCode})`);
      }
    }

    const failed = results.filter((r) => r.exitCode !== 0);
    if (failed.length) {
      throw new Error(`Wave ${w + 1} failed: tasks ${failed.map((f) => f.taskNum).join(", ")}`);
    }
  }

  log("✅", "plan", 0, "COMPLETE", `All ${taskCount} tasks done`);
  console.log(`\n✅ Plan complete! ${taskCount} tasks executed.`);
}

/** Show latest plan log. */
export function showPlanLog(lines = 50) {
  const { readdirSync } = require("fs");
  try {
    const logs = readdirSync("/tmp").filter((f) => f.startsWith("agent-pd-")).sort().reverse();
    if (logs.length) {
      const content = readFileSync(join("/tmp", logs[0]), "utf-8");
      console.log(content.split("\n").slice(-lines).join("\n"));
    } else {
      console.error("No plan logs found.");
    }
  } catch {
    console.error("No plan logs found.");
  }
}

// --- Helpers ---

function buildNotifier(channel, session) {
  return async (message) => {
    const promises = [];
    if (channel) promises.push(sendToChannel(channel, message).catch(() => {}));
    if (session) promises.push(sendToSession(session, message).catch(() => {}));
    await Promise.all(promises);
  };
}
