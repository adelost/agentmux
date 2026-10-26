import { readFileSync, unlinkSync } from "node:fs";

/** WHAT: Tracks a bridge marker file by removing it only while it names this process. WHY: Prevents a stopping duplicate from erasing the marker of the bridge that stays. */
export function clearOwnMarker(path, pid = process.pid) {
  try {
    if (readFileSync(path, "utf-8").trim() !== String(pid)) return;
    unlinkSync(path);
  } catch {}
}
