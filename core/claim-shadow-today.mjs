import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** WHAT: Builds one line counting today's actual shadow-flagged replies. WHY: Keeps duplicate turns, name warnings and missing logs from inflating the measurement. */
export function claimShadowTodayLine({ path = join(homedir(), ".agentmux/claim-guard/decisions.jsonl"), now = Date.now() } = {}) {
  let text;
  try { text = readFileSync(path, "utf8"); }
  catch { return "Skuggmätning idag (UTC): inga mätdata"; }
  const day = new Date(now).toISOString().slice(0, 10), flagged = new Set();
  let complete = true;
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let row; try { row = JSON.parse(line); } catch { complete = false; continue; }
    if (row.event !== "shadow" || row.verdict !== "hold") continue;
    const at = Date.parse(row.at);
    if (!Number.isFinite(at)) { complete = false; continue; }
    if (at > now || new Date(at).toISOString().slice(0, 10) !== day) continue;
    if (!row.turnId || !row.paneKey) { complete = false; continue; }
    flagged.add(`${row.paneKey}:${row.turnId}`);
  }
  return `Skuggmätning idag (UTC): ${complete ? "" : "minst "}${flagged.size} flaggade svar${complete ? "" : " (ofullständiga mätdata)"}`;
}
