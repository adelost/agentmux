import { readFileSync, unlinkSync, writeFileSync } from "node:fs";

const holderOf = path => {
  try {
    const value = Number.parseInt(readFileSync(path, "utf-8").trim(), 10);
    return Number.isSafeInteger(value) && value > 0 ? value : null;
  } catch { return null; }
};
const processAlive = pid => { try { process.kill(pid, 0); return true; } catch (error) { return error.code === "EPERM"; } };

/** WHAT: Tracks a bridge marker file by removing it only while it names this process. WHY: Prevents a stopping duplicate from erasing the marker of the bridge that stays. */
export function clearOwnMarker(path, pid = process.pid) {
  try {
    if (readFileSync(path, "utf-8").trim() !== String(pid)) return;
    unlinkSync(path);
  } catch {}
}

/** WHAT: Tracks a bridge marker file by removing it only when its pid is not running. WHY: Keeps a launch from erasing the marker of a bridge that lives. */
export function clearDeadMarker(path, alive = processAlive) {
  const holder = holderOf(path);
  if (holder && alive(holder)) return false;
  try { unlinkSync(path); } catch {}
  return true;
}

/** WHAT: Tracks bridge ownership by creating the pidfile exclusively. WHY: Keeps two starting bridges from both believing they own it. */
export function claimPidFile(path, pid = process.pid, { alive = processAlive } = {}) {
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      writeFileSync(path, String(pid), { flag: "wx" });
      return { claimed: true, holder: pid };
    } catch (error) {
      if (error.code !== "EEXIST") throw error;
    }
    const holder = holderOf(path);
    if (holder === pid) return { claimed: true, holder: pid };
    if (holder && alive(holder)) return { claimed: false, holder };
    clearDeadMarker(path, alive);
  }
  throw new Error(`could not claim ${path}`);
}
