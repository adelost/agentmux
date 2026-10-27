import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const sameRoot = (left, right) => {
  if (typeof left !== "string" || !left.startsWith("/")) return false;
  try { return realpathSync(left) === realpathSync(right); } catch { return false; }
};
// Same relative Markdown path contract as the stats ledger source configuration.
/** WHAT: Checks the shared relative Markdown ledger-path contract. WHY: Prevents configured ledger paths from escaping their repository. */
export const validTaskLedgerPath = path => typeof path === "string" && path.length <= 100
  && /^[\w.-]+(?:\/[\w.-]+)*\.md$/u.test(path) && !path.split("/").some(part => part === "." || part === "..");

/** WHAT: Resolves a repository's configured task ledger. WHY: Keeps row bindings on the ledger stats reads, with the existing default for unmapped repositories. */
export function askRowLedger(root, { sourcesPath = join(homedir(), ".config/v1d-stats/ledger-sources.json") } = {}) {
  let sources;
  try { sources = JSON.parse(readFileSync(sourcesPath, "utf8")); }
  catch (error) { if (error.code === "ENOENT") return "docs/TASKS.md"; throw error; }
  if (!Array.isArray(sources)) throw Error("ledger-sources.json must contain an array");
  const source = sources.findLast(source => sameRoot(source?.root, root));
  if (source?.path === undefined) return "docs/TASKS.md";
  if (!validTaskLedgerPath(source.path)) throw Error("Invalid configured task ledger path");
  return source.path;
}
