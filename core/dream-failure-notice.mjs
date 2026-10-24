import { closeSync, fsyncSync, mkdirSync, openSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { writeDreamAtomic } from "./dream-commit.mjs";
import { assertDreamWritePath } from "./dream-memory-effects.mjs";

/** WHAT: Stores one human notice per failed night using the existing transport. WHY: Prevents a lost response from triggering a blind duplicate. */
export async function notifyDreamFailure({ dateKey, reason, notify, home = homedir(), now = new Date() }) {
  const directory = join(home, ".agentmux", "dream-failure-notices"), path = join(directory, `${dateKey}.json`);
  assertDreamWritePath(path);
  let previous;
  try { previous = JSON.parse(readFileSync(path, "utf8")); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (previous) return previous;
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const detail = String(reason || "unknown").replace(/[<>]/gu, "").replace(/\s+/gu, " ").slice(0, 200);
  const record = { version: 1, dateKey, at: now.toISOString(), reason: detail, outcome: "unknown" };
  let fd;
  try { fd = openSync(path, "wx", 0o600); }
  catch (error) {
    if (error.code !== "EEXIST") throw error;
    return { outcome: "unknown", dateKey, reason: "another controller claimed this notice" };
  }
  try { writeFileSync(fd, `${JSON.stringify(record)}\n`); fsyncSync(fd); } finally { closeSync(fd); }
  const directoryFd = openSync(directory, "r");
  try { fsyncSync(directoryFd); } finally { closeSync(directoryFd); }
  try {
    const result = await notify(`Dream ${dateKey} misslyckades: ${detail}. Ingen verifierad nattlig sammanfattning har sparats. Befintligt resultat bevaras för återhämtning utan en ny kuratorkörning.`,
      { title: "amux dream", level: "warn", strictSingleAttempt: true, idempotencyKey: `dream-failed:${dateKey}` });
    record.outcome = result?.sent ? "sent" : result?.outcome === "not-sent" ? "not-sent" : "unknown";
    if (result?.messageId) record.messageId = result.messageId;
    if (result?.channelId) record.channelId = result.channelId;
    if (result?.target) record.target = result.target;
  } catch { /* The send may have succeeded: retain its pre-I/O unknown fence. */ }
  writeDreamAtomic(path, `${JSON.stringify(record)}\n`);
  return record;
}
