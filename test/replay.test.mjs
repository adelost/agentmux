// Replay test: re-run extract pipeline against real recordings.
// Recordings are produced by running agentmux with AGENTMUX_RECORD=1.
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

const allRecordings = loadRecordings();
// Only recordings captured via the tmux extract path can be replayed against
// the extract pipeline. jsonl-sourced recordings (claude or codex) have a
// synthesized raw/turn that wasn't produced by tmux, so re-extracting from
// it is meaningless.
const recordings = allRecordings.filter((r) => r.source === "tmux" || r.source === undefined);

feature("replay: extract pipeline on recorded data", () => {
  if (recordings.length === 0) {
    unit("no tmux recordings to replay", {
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
    unit("no tmux recordings to sanity-check", {
      when: ["checking", () => null],
      then: ["nothing to check", () => expect(true).toBe(true)],
    });
    return;
  }

  for (const r of recordings) {
    unit(`${r.file}: prompt was echoed in raw buffer`, {
      given: ["recording", () => r],
      when: ["checking raw contains prompt start", (rec) => ({
        rec,
        // Only check first 20 chars - narrow panes wordwrap longer prompts,
        // breaking them across lines. The first 20 chars always fit on one
        // line even on a 42-col pane.
        hasPrompt: rec.raw.includes(rec.prompt.slice(0, Math.min(20, rec.prompt.length))),
      })],
      then: ["raw should contain the prompt start", ({ rec, hasPrompt }) => {
        expect(hasPrompt, `prompt "${rec.prompt.slice(0, 40)}" not found in raw buffer`).toBe(true);
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
