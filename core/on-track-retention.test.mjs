import { feature, component, unit, expect } from "bdd-vitest";
import { existsSync, mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createState } from "./state.mjs";
import { createOnTrackMonitor } from "./on-track-monitor.mjs";
import { onTrackCoveredUntil } from "./on-track-contract.mjs";
import { retainOnTrackState } from "./on-track-retention.mjs";

const HOUR = 3600000, INPUT_CHARS = 200_000;
const frozenInput = () => ({ tip: "abc", asks: [], decisions: [{ id: "d1", text: "x".repeat(INPUT_CHARS) }] });

feature("on-track state stays bounded", () => {
  // defect: on 2026-10-28 the state held 78 full cycles (238 MB) and every save rewrote all of it, 4-8 MB/s to disk.
  component("a closed cycle leaves only its summary in the state and its full copy in the archive", {
    given: ["a monitor that has started seven hourly cycles, each with a 200 KB frozen input", async () => {
      const root = mkdtempSync(join(tmpdir(), "amux-on-track-retention-"));
      const state = createState(join(root, "state.json"));
      const project = { id: "cutkit", root, ledger: "TASKS.md", reviewer: "lsrc:3", dispatcher: "lsrc:0", livePaths: [] };
      let at = Date.parse("2026-10-28T00:00:00Z");
      const monitor = createOnTrackMonitor({ state, projects: () => [project], now: () => at,
        snapshot: async () => frozenInput(), send: async () => ({ id: "job" }), log: () => {} });
      for (let hour = 0; hour < 7; hour++) { await monitor.tick(); at += HOUR; }
      return root;
    }],
    when: ["the state file and the archive are read", root => ({
      stateBytes: statSync(join(root, "state.json")).size,
      archived: existsSync(join(root, "history.jsonl"))
        ? readFileSync(join(root, "history.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [],
    })],
    then: ["the state holds one frozen input and the archive holds the six closed cycles whole", r => {
      expect(r.stateBytes).toBeLessThan(2 * INPUT_CHARS);
      expect(r.archived.map(cycle => cycle.decisions[0].text.length)).toEqual(Array(6).fill(INPUT_CHARS));
    }],
  });

  unit("a cycle past the window leaves unless the last valid review or a pending delivery points to it", {
    given: ["old, reviewed, pending and recent cycles and an old and a recent command capture", () => {
      const now = Date.parse("2026-10-28T12:00:00Z"), old = now - 49 * HOUR, reviewAt = old + 60000;
      const record = { lastReview: { valid: true, at: reviewAt } };
      const data = {
        projects: { cutkit: record },
        history: [
          { id: "old", at: old, decisions: ["frozen"] },
          { id: "reviewed", at: old, decisions: ["frozen"], review: { valid: true, at: reviewAt, receipt: { frozen: true } } },
          { id: "pending", at: old, deliveries: { reminder: { status: "queued" } } },
          { id: "recent", at: now - HOUR, decisions: ["frozen"] },
        ],
        commands: { a: { at: new Date(old).toISOString(), stdout: "old" }, b: { at: new Date(now - HOUR).toISOString(), stdout: "new" } },
      };
      return { now, record, data };
    }],
    when: ["retention runs", ({ now, record, data }) => ({ record, data, archived: retainOnTrackState(data, now) })],
    then: ["only the unreferenced old cycle and command leave, and every full cycle is archived once", ({ record, data, archived }) => {
      expect(data.history.map(cycle => cycle.id)).toEqual(["reviewed", "pending", "recent"]);
      expect(data.history.some(cycle => "decisions" in cycle || "receipt" in (cycle.review || {}))).toBe(false);
      expect(onTrackCoveredUntil(record, data.history)).toBe(Date.parse("2026-10-28T12:00:00Z") - 49 * HOUR);
      expect(archived.cycles.map(cycle => cycle.id)).toEqual(["old", "reviewed", "pending", "recent"]);
      expect(Object.keys(data.commands)).toEqual(["b"]);
      expect(archived.commands.map(command => command.key)).toEqual(["a"]);
    }],
  });
});
