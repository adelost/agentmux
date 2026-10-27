import { onTrackRows } from "./on-track-evidence.mjs";

const normalized = value => value.normalize("NFKD").replace(/\p{Diacritic}/gu, "").toLowerCase().replace(/[^a-z0-9#]/gu, "");

/** WHAT: Reads TASKS with the shared parser and its priority column. WHY: Keeps current project tables canonical while preserving their thresholds. */
export function stateAgeRows(text) {
  const rows = [];
  let headers = [], header = "";
  for (const [lineIndex, line] of text.split("\n").entries()) {
    if (!line.startsWith("|")) continue;
    const cells = line.split(/(?<!\\)\|/u).slice(1, -1).map(s => s.trim());
    if (["#", "id", "row"].includes(normalized(cells[0] || ""))) { headers = cells.map(normalized); header = line; }
    else if (/^\d+[a-z]*$/u.test(cells[0] || "")) {
      const index = headers.findIndex(h => ["prio", "priority", "prioritet"].includes(h));
      const row = Object.values(onTrackRows(`${header}\n${line}`))[0];
      if (row) rows.push({ ...row, line: lineIndex + 1, priority: /\bP[0-9]+\b/u.exec(cells[index] || "")?.[0] || "P1" });
    }
  }
  return rows;
}

