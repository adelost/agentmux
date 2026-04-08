// Replay test: re-run extract pipeline against real recordings.
// Recordings are produced by running agentus with AGENTUS_RECORD=1.
// This is our regression net: any extract change must still reproduce
// the exact items that were sent to Discord on real data.

import { feature, unit, expect } from "bdd-vitest";
import { readFileSync, readdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { extractTurnByPrompt, classifyLines, extractMixedStream } from "../core/extract.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const recordingsDir = join(__dir, "recordings");

function loadRecordings() {
  if (!existsSync(recordingsDir)) return [];
  return readdirSync(recordingsDir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const path = join(recordingsDir, f);
      const data = JSON.parse(readFileSync(path, "utf-8"));
      return { file: f, ...data };
    });
}

function replay(recording) {
  const turn = extractTurnByPrompt(recording.raw, recording.prompt);
  const items = extractMixedStream(classifyLines(turn));
  return { turn, items };
}

const recordings = loadRecordings();

feature("replay: extract pipeline on recorded data", () => {
  if (recordings.length === 0) {
    unit("no recordings yet — skipping", {
      when: ["checking", () => null],
      then: ["nothing to replay", () => expect(true).toBe(true)],
    });
    return;
  }

  for (const r of recordings) {
    unit(`${r.file}: replayed items match recorded items`, {
      given: ["recording", () => r],
      when: ["re-running extract", (rec) => replay(rec)],
      then: ["items are unchanged", (result, rec) => {
        expect(result.items).toEqual(rec.items);
      }],
    });
  }
});

feature("replay: sanity checks on recorded data", () => {
  if (recordings.length === 0) {
    unit("no recordings yet — skipping sanity checks", {
      when: ["checking", () => null],
      then: ["nothing to check", () => expect(true).toBe(true)],
    });
    return;
  }

  for (const r of recordings) {
    unit(`${r.file}: prompt was echoed in raw buffer`, {
      given: ["recording", () => r],
      when: ["checking raw contains prompt", (rec) => ({
        rec,
        hasPrompt: rec.raw.includes(rec.prompt.slice(0, Math.min(40, rec.prompt.length))),
      })],
      then: ["raw should contain the prompt text we sent", ({ rec, hasPrompt }) => {
        // If this fails, extractTurnByPrompt will fall back to extractLastTurn
        // which can return the wrong turn entirely.
        expect(hasPrompt, `prompt "${rec.prompt.slice(0, 60)}" not found in raw buffer`).toBe(true);
      }],
    });

    unit(`${r.file}: discordSent is non-empty`, {
      given: ["recording", () => r],
      when: ["counting sent items", (rec) => rec.discordSent?.length || 0],
      then: ["at least context was sent", (count, rec) => {
        // Every recording should have sent at least the context line
        expect(count, `nothing was sent to Discord for ${rec.file}`).toBeGreaterThan(0);
      }],
    });
  }
});
