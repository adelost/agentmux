import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { listAgents } from "../cli/config.mjs";
import { runtimeAgentsPath } from "./runtime-defaults.mjs";

/** WHAT: Reads existing project roots for source checks. WHY: Claims reuse actual project bindings instead of a second project registry. */
export function claimRepoPaths(configPath = runtimeAgentsPath()) {
  const paths = listAgents(configPath).map(agent => agent.dir);
  try {
    const sources = JSON.parse(readFileSync(join(homedir(), ".config/v1d-stats/ledger-sources.json"), "utf8"));
    paths.push(...sources.map(source => source.root));
  } catch (error) { if (error.code !== "ENOENT") throw error; }
  return [...new Set(paths.filter(Boolean))];
}
