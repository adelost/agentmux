import { unit, feature, expect } from "bdd-vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { scheduleSessionTrim } from "./session-trim-schedule.mjs";

const NOW = Date.parse("2026-10-27T23:00:00Z");
const HOUR = 60 * 60_000;

function schedule(lastRunHoursAgo) {
  const dir = mkdtempSync(join(tmpdir(), "amux-trim-schedule-"));
  const marker = join(dir, "session-trim.last");
  if (lastRunHoursAgo != null) {
    writeFileSync(marker, "");
    const at = (NOW - lastRunHoursAgo * HOUR) / 1000;
    utimesSync(marker, at, at);
  }
  const starts = [];
  const start = (command, args) => {
    const child = Object.assign(new EventEmitter(), { stdout: new EventEmitter() });
    starts.push({ command, args, child });
    return child;
  };
  const trim = scheduleSessionTrim({ marker, now: () => NOW, start, log: () => {} });
  return { dir, starts, trim };
}

feature("periodic journal trim", () => {
  unit("a last run six hours old starts one amux trim process", {
    given: ["a marker from seven hours ago", () => schedule(7)],
    when: ["the timer checks twice while the trim runs", (ctx) => { ctx.trim.tick(); ctx.trim.tick(); return ctx; }],
    then: ["one bounded trim process started", ({ dir, starts, trim }) => {
      try {
        expect(starts).toHaveLength(1);
        expect(starts[0].args.slice(-3)).toEqual(["trim", "--max-files", "8"]);
      } finally { trim.stop(); rmSync(dir, { recursive: true, force: true }); }
    }],
  });

  unit("a recent run is not repeated", {
    given: ["a marker from one hour ago", () => schedule(1)],
    when: ["the timer checks", (ctx) => { ctx.trim.tick(); return ctx; }],
    then: ["no trim process starts", ({ dir, starts, trim }) => {
      try { expect(starts).toHaveLength(0); } finally { trim.stop(); rmSync(dir, { recursive: true, force: true }); }
    }],
  });
});
