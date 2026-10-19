// Remembers the last quota park of each Claude pane until amux resumes it or the pane moves on by itself.
// The bridge writes a record when it parks a pane; quota recovery reads it, so both sides construct the store
// with the same directory, in the pattern of the self-compact store.

import { mkdirSync, readdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const DEFAULT_DIR = join(homedir(), ".agentmux", "quota-parks");
const fileFor = (dir, agent, pane) => join(dir, `${agent}--p${Number(pane) || 0}.json`);

/**
 * WHAT: Builds the per-pane park records that the bridge writes and quota recovery settles.
 * WHY: Keeps a parked pane from going unseen once neither a limit receipt nor a queued job remains.
 */
export function createQuotaParkStore({ dir = DEFAULT_DIR } = {}) {
  function write(record) {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const path = fileFor(dir, record.agentName, record.pane);
    writeFileSync(`${path}.tmp`, `${JSON.stringify(record)}\n`, { mode: 0o600 });
    renameSync(`${path}.tmp`, path);
    return record;
  }
  function read(agent, pane) {
    try { return JSON.parse(readFileSync(fileFor(dir, agent, pane), "utf8")); }
    catch (error) { if (error.code === "ENOENT") return null; throw error; }
  }
  return {
    /** A new park replaces the pane's earlier record, settled or not. */
    record: (park) => write({ ...park, state: "parked" }),
    read,
    list() {
      let names;
      try { names = readdirSync(dir); }
      catch (error) { if (error.code === "ENOENT") return []; throw error; }
      return names.filter((name) => name.endsWith(".json")).map((name) => JSON.parse(readFileSync(join(dir, name), "utf8")));
    },
    /** Adds facts to the same park; a newer park of that pane is never overwritten. */
    update(park, fields) {
      const current = read(park.agentName, park.pane);
      if (current?.parkedAt !== park.parkedAt) return current;
      return write({ ...current, ...fields });
    },
  };
}
