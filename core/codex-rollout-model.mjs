import { createReadStream } from "node:fs";
import { createInterface } from "node:readline";
import { observationFromCodexEntry } from "./native-model-observation.mjs";

/** WHAT: Reads the last model from one already-owned rollout. WHY: A long tool tail can hide turn_context beyond the bounded status scan. */
export async function readCodexRolloutModel(path, sessionId) {
  const input = createReadStream(path, { encoding: "utf8" });
  const lines = createInterface({ input, crlfDelay: Infinity });
  let last = null;
  try {
    for await (const line of lines) {
      if (!line.includes('"turn_context"') && !line.includes('"thread_settings_applied"')) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const observed = observationFromCodexEntry(entry);
      const settings = entry?.type === "event_msg" && entry.payload?.type === "thread_settings_applied"
        ? entry.payload.thread_settings : null;
      const model = observed?.model || settings?.model;
      if (model) last = { sessionId, model, effort: observed?.effort
        ?? settings?.collaboration_mode?.settings?.reasoning_effort
        ?? settings?.reasoning_effort ?? settings?.effort ?? null };
    }
    return last;
  } finally {
    lines.close();
    input.destroy();
  }
}
