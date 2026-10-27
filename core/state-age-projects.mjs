import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, isAbsolute, resolve } from "node:path";
import { readOnTrackProjects } from "./on-track-projects.mjs";
import { validTaskLedgerPath } from "./ask-row-ledger.mjs";

/** WHAT: Resolves board ledgers and their explicit project routing. WHY: Keeps unmapped dispatchers visible without guessing a pane to wake. */
export function readStateAgeProjects({ routes = readOnTrackProjects(), sourcesPath = join(homedir(), ".config/v1d-stats/ledger-sources.json") } = {}) {
  let sources = [];
  try { sources = JSON.parse(readFileSync(sourcesPath, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (!Array.isArray(sources)) throw Error("State-age board ledger sources must be an array");
  const projects = new Map(routes.map(p => [resolve(p.root), { ...p, panes: p.askPanels || [] }]));
  for (const source of sources) {
    if (!isAbsolute(source.root || "")) throw Error("State-age board root must be absolute");
    if (source.path !== undefined && !validTaskLedgerPath(source.path)) throw Error("Invalid configured task ledger path");
    const root = resolve(source.root), existing = projects.get(root);
    projects.set(root, { ...existing, id: existing?.id || basename(root), root,
      ledger: source.path || existing?.ledger || "docs/TASKS.md", dispatcher: existing?.dispatcher || null,
      panes: existing?.askPanels || [], boardSource: sourcesPath });
  }
  return [...projects.values()].map(p => ({ ...p, dispatcher: p.id === "cutkit" ? "lsrc:3" : p.dispatcher }));
}
