// Fleet-wide generated-hints synchronization.
//
// The template remains owned by agent.mjs, where pane creation already uses
// it. This module only coordinates configured workspace roots and reports the
// result, so bridge startup and the CLI cannot grow separate sync behavior.

import { resolve } from "path";

export function syncConfiguredAgentHints(agents, {
  ensure,
  version,
} = {}) {
  if (typeof ensure !== "function") throw new Error("hints sync requires an ensure function");
  const targets = new Map();
  for (const agent of Array.isArray(agents) ? agents : []) {
    if (!agent?.dir) continue;
    const rootDir = resolve(String(agent.dir));
    const current = targets.get(rootDir) || { rootDir, agents: [] };
    current.agents.push(String(agent.name || "unknown"));
    targets.set(rootDir, current);
  }

  const entries = [];
  for (const target of targets.values()) {
    try {
      const result = ensure(target.rootDir);
      const files = Array.isArray(result?.files) ? result.files : [];
      entries.push({
        ...target,
        files,
        changedFiles: files.filter((file) => file.changed).length,
        errors: files.filter((file) => file.error).map((file) => ({
          file: file.name,
          error: file.error,
        })),
      });
    } catch (error) {
      entries.push({
        ...target,
        files: [],
        changedFiles: 0,
        errors: [{ file: null, error: String(error.message || error) }],
      });
    }
  }

  return {
    version,
    configuredSessions: Array.isArray(agents) ? agents.filter((agent) => agent?.dir).length : 0,
    workspaceRoots: entries.length,
    changedFiles: entries.reduce((sum, entry) => sum + entry.changedFiles, 0),
    errors: entries.flatMap((entry) => entry.errors.map((error) => ({
      rootDir: entry.rootDir,
      agents: entry.agents,
      ...error,
    }))),
    entries,
  };
}
/**
 * A separate CLI process loads the current template from disk, but an older
 * bridge can still hold and later rewrite its in-memory copy. Heartbeat
 * provenance makes that gap explicit instead of claiming the sync is final.
 */
export function assessRunningBridgeHints(beat, {
  currentVersion,
  pidAlive = false,
} = {}) {
  if (!beat || !pidAlive) return { state: "not-running", restartRequired: false };
  if (beat.hintsVersion === currentVersion) {
    return { state: "current", restartRequired: false, runningVersion: beat.hintsVersion };
  }
  return {
    state: "stale",
    restartRequired: true,
    runningVersion: beat.hintsVersion || "unknown",
    warning: `bridge restart required: running hints ${beat.hintsVersion || "unknown"}, repo hints ${currentVersion}`,
  };
}
