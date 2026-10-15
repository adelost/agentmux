import fs from "node:fs";
import { observationFromCodexEntry } from "./native-model-observation.mjs";
import { readSearchRecords } from "./search-jsonl.mjs";
import { readCodexRecordPrefix } from "./codex-record-prefix.mjs";

const readings = new Map();

function modelRecord(entry) {
  const observed = observationFromCodexEntry(entry);
  const settings = entry?.type === "event_msg" && entry.payload?.type === "thread_settings_applied"
    ? entry.payload.thread_settings : null;
  const model = observed?.model || settings?.model;
  return model ? { model, effort: observed?.effort
    ?? settings?.collaboration_mode?.settings?.reasoning_effort
    ?? settings?.reasoning_effort ?? settings?.effort ?? null } : null;
}

function needsModelRecord({ type, payloadType }) {
  return type === "turn_context" || (type === "event_msg" && payloadType === "thread_settings_applied");
}

/** WHAT: Reads the last model from one already-owned rollout. WHY: A long tool tail can hide turn_context beyond the bounded status scan. */
export async function readCodexRolloutModel(path, sessionId) {
  const stat = fs.statSync(path), cached = readings.get(path);
  const sameFile = cached && stat.dev === cached.dev && stat.ino === cached.ino && stat.size >= cached.size;
  const unchanged = sameFile && stat.size === cached.size && stat.mtimeMs === cached.mtimeMs;
  if (unchanged) return cached.last ? { sessionId, ...cached.last } : null;
  const appended = sameFile && stat.size > cached.size;
  let last = appended ? cached.last : null;
  let incompleteStart = appended ? cached.offset : 0;
  const fd = fs.openSync(path, "r");
  try {
    for (const record of readSearchRecords(path, { byteOffset: incompleteStart, endByteOffset: stat.size })) {
      incompleteStart = record.byteOffset;
      if (record.skippedBytes) {
        const prefix = readCodexRecordPrefix(fd, record.byteOffset);
        if (!prefix || needsModelRecord(prefix)) throw new Error(`Codex model evidence exceeds the record limit at byte ${record.byteOffset}`);
        continue;
      }
      const line = record.raw;
      if (!line.includes('"turn_context"') && !line.includes('"thread_settings_applied"')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      last = modelRecord(entry) || last;
    }
    const tail = Buffer.alloc(1);
    const ended = stat.size > 0 && fs.readSync(fd, tail, 0, 1, stat.size - 1) === 1 && tail[0] === 10;
    readings.delete(path);
    readings.set(path, { dev: stat.dev, ino: stat.ino, size: stat.size, mtimeMs: stat.mtimeMs,
      offset: ended ? stat.size : incompleteStart, last });
    while (readings.size > 32) readings.delete(readings.keys().next().value);
    return last ? { sessionId, ...last } : null;
  } finally { fs.closeSync(fd); }
}
