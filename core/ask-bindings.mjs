import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { defaultAskBindingsPath } from "./ask-binding-paths.mjs";

const KINDS = new Set(["row", "commit", "close"]);
const validBinding = row => row && typeof row.ledgerId === "string" && row.ledgerId.length > 0
  && KINDS.has(row.kind) && typeof row.ref === "string" && row.ref.trim().length > 0
  && /^[a-zA-Z0-9_-]{1,64}:\d+$/u.test(row.by) && Number.isFinite(Date.parse(row.ts));

/** WHAT: Reads explicit binding evidence, failing on corrupt records. WHY: Keeps unreadable evidence from silently closing an ask. */
export function readAskBindings({ path = defaultAskBindingsPath() } = {}) {
  let text;
  try { text = readFileSync(path, "utf8"); }
  catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return text.split("\n").filter(line => line.trim()).map(line => {
    const row = JSON.parse(line);
    if (!validBinding(row)) throw Error("Invalid ask binding record");
    return row;
  });
}

const gitIn = (cwd, args) => execFileSync("git", ["-C", cwd, ...args], {
  encoding: "utf8", timeout: 5000, stdio: ["ignore", "pipe", "pipe"],
}).trim();

/** WHAT: Checks one repository target before any append. WHY: Keeps row and revision references scoped to the invoking repo. */
export function askBindingTarget({ kind, value, cwd = process.cwd() }) {
  if (!KINDS.has(kind) || typeof value !== "string" || !value.trim()) throw Error("A row, commit or non-empty close reason is required");
  if (kind === "close") return value.trim();
  const bare = gitIn(cwd, ["rev-parse", "--is-bare-repository"]) === "true";
  const root = gitIn(cwd, ["rev-parse", bare ? "--absolute-git-dir" : "--show-toplevel"]);
  if (kind === "commit") return `${root}@${gitIn(root, ["rev-parse", "--verify", "--end-of-options", `${value}^{commit}`])}`;
  if (!/^\d+[a-z]?$/u.test(value)) throw Error("--row requires an exact ledger row id");
  const file = join(root, "docs", "TASKS.md");
  const text = bare ? gitIn(root, ["show", "HEAD:docs/TASKS.md"]) : readFileSync(file, "utf8");
  if (!text.split("\n").some(line => line.split("|")[1]?.trim() === value)) throw Error(`Task row ${value} does not exist in ${file}`);
  return `${file}:${value}`;
}

/** WHAT: Stores one fully validated batch of exact ask identities. WHY: Prevents an unknown id or missing target from partially binding a bulk command. */
export function bindAsks({ ids, kind, value, by, ledgerEntries, cwd, path = defaultAskBindingsPath(), now = Date.now }) {
  if (!Array.isArray(ids) || !ids.length) throw Error("At least one exact ask id is required");
  const known = new Set(ledgerEntries.map(row => row.id));
  for (const id of ids) if (!known.has(id)) throw Error(`Unknown ask id ${id}`);
  const ref = askBindingTarget({ kind, value, cwd });
  const ts = new Date(now()).toISOString();
  const rows = [...new Set(ids)].map(ledgerId => ({ ledgerId, kind, ref, by, ts }));
  if (!rows.every(validBinding)) throw Error("Ask binding requires an agent:pane caller");
  // Detect an incomplete earlier append before extending it; never join a torn line to a new record.
  readAskBindings({ path });
  let prior = "";
  try { prior = readFileSync(path, "utf8"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  appendFileSync(path, (prior && !prior.endsWith("\n") ? "\n" : "") + rows.map(row => JSON.stringify(row) + "\n").join(""), { mode: 0o600 });
  return rows;
}
