import { createHash } from "node:crypto";
import { readFileSync, realpathSync } from "node:fs";
import { join } from "node:path";

/** WHAT: Resolves the existing scheduled-attempt path. WHY: Keeps health and scheduling on the same workspace identity. */
export function dreamAttemptPath(workspace, home, dateKey) {
  const key = createHash("sha256").update(realpathSync(workspace)).digest("hex").slice(0, 24);
  return join(home, ".agentmux", "dream-schedule", key, `${dateKey}.json`);
}

/** WHAT: Reads the original whole-night outcome. WHY: Prevents a saved digest from hiding failed or interrupted maintenance. */
export function readDreamAttempt(workspace, home, dateKey) {
  let record;
  try { record = JSON.parse(readFileSync(dreamAttemptPath(workspace, home, dateKey), "utf8")); }
  catch (error) { if (error.code === "ENOENT") return null; throw error; }
  if (record.schemaVersion !== 1 || record.dateKey !== dateKey || record.workspace !== realpathSync(workspace)
      || !["started", "completed", "maintenance-unresolved", "unresolved"].includes(record.state)) {
    throw new Error("scheduled Dream attempt identity/state invalid");
  }
  return { state: record.state, exitCode: record.exitCode ?? null, finishedAt: record.finishedAt ?? null };
}
