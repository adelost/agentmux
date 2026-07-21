import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  emptyDreamReceipts, isDreamActivityTurn, readDreamReceipts, recordDreamReceipts,
} from "./dream-eligibility.mjs";

feature("nightly dream receipts", () => {
  unit("maintenance messages cannot manufacture activity", {
    when: ["classifying user-role text", () => ({
      human: isDreamActivityTurn("fixa den riktiga buggen"),
      delegated: isDreamActivityTurn("[from lsrc:2] reviewa PR #12"),
      dream: isDreamActivityTurn("[dream 2026-07-21 04:00] summarize"),
      compact: isDreamActivityTurn("/compact"),
      recovery: isDreamActivityTurn("[AMUX AUTOMATIC CRASH RECOVERY · SAME SESSION] Fortsätt."),
    })],
    then: ["only real work remains", (result) => expect(result).toEqual({
      human: true, delegated: true, dream: false, compact: false, recovery: false,
    })],
  });

  unit("one successful batch advances all included cursors atomically", {
    given: ["two included panes and one pane not in the batch", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-dream-receipts-"));
      return { root, path: join(root, "receipts.json") };
    }],
    when: ["recording the exact batch", ({ path }) => recordDreamReceipts(emptyDreamReceipts(), [
      { agent: "ai", pane: 0, activityCursor: "2026-07-21T10:00:00Z", turns: 4 },
      { agent: "lsrc", pane: 3, activityCursor: "2026-07-21T11:00:00Z", turns: 8 },
    ], { path, dateKey: "2026-07-21", now: new Date("2026-07-21T12:00:00Z") })],
    then: ["only included panes are durable", (state, { root, path }) => {
      expect(Object.keys(state.panes)).toEqual(["ai:0", "lsrc:3"]);
      expect(readDreamReceipts(path)).toEqual(state);
      expect(JSON.parse(readFileSync(path, "utf8")).panes["lsrc:3"]).toMatchObject({
        summarizedTurns: 8, dreamedAt: "2026-07-21T12:00:00.000Z",
      });
      rmSync(root, { recursive: true, force: true });
    }],
  });

  unit("one invalid target prevents the whole batch write", {
    given: ["an existing receipt file", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-dream-receipts-invalid-"));
      const path = join(root, "receipts.json");
      writeFileSync(path, `${JSON.stringify(emptyDreamReceipts())}\n`);
      return { root, path, before: readFileSync(path, "utf8") };
    }],
    when: ["recording a target without a cursor", ({ path }) => {
      try {
        recordDreamReceipts(emptyDreamReceipts(), [{ agent: "ai", pane: 0 }], { path });
        return null;
      } catch (error) { return error; }
    }],
    then: ["the state remains byte-identical", (error, { root, path, before }) => {
      expect(error?.message).toContain("without an activity cursor");
      expect(readFileSync(path, "utf8")).toBe(before);
      rmSync(root, { recursive: true, force: true });
    }],
  });

  unit("corrupt state fails closed", {
    given: ["a corrupt receipt", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-dream-corrupt-"));
      const path = join(root, "state.json");
      writeFileSync(path, "{broken");
      return { root, path };
    }],
    when: ["reading it", ({ path }) => {
      try { readDreamReceipts(path); return null; } catch (error) { return error; }
    }],
    then: ["the exact failure is visible", (error, { root }) => {
      expect(error?.message).toContain("dream receipt state is unreadable");
      rmSync(root, { recursive: true, force: true });
    }],
  });
});
