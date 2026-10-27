import { afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { component, expect, feature, unit } from "bdd-vitest";
import { appendCreditStopLine, creditStopText, readCreditStopWeek } from "./codex-credit-log.mjs";

// lsrc:0 for api:0, 2026-10-27: every case the credit guard acts on or lets run is logged, and the week's sum is read at the week shift.
const NOW = Date.parse("2026-10-30T12:00:00Z");
const roots = [];
afterEach(() => roots.splice(0).forEach(root => rmSync(root, { recursive: true, force: true })));
const logPath = () => { const dir = mkdtempSync(join(tmpdir(), "credit-log-")); roots.push(dir); return join(dir, "codex-credit-stop.jsonl"); };
const line = (at, caseKey, kind, drawn, extra = {}) => ({ at, case: caseKey, pane: "claw:5", kind, window: "session", creditsDrawn: drawn, ...extra });

feature("the credit guard's log gives the week's sum", () => {
  component("a case counts once, at its settled figure, and an old case does not count", {
    given: ["one Esc case settled at 3.2, one owner turn settled at 2.5, one Esc case from eight days ago", () => {
      const path = logPath();
      appendCreditStopLine(line("2026-10-29T08:00:00Z", "a", "esc", 1.4), path);
      appendCreditStopLine(line("2026-10-29T08:00:30Z", "a", "settled", 3.2), path);
      appendCreditStopLine(line("2026-10-30T09:00:00Z", "b", "owner-turn", 0), path);
      appendCreditStopLine(line("2026-10-30T09:20:00Z", "b", "settled", 2.5), path);
      appendCreditStopLine(line("2026-10-21T08:00:00Z", "old", "esc", 40), path);
      return path;
    }],
    when: ["reading the week", path => readCreditStopWeek({ now: NOW, path })],
    then: ["one stopped, one owner turn, 5.7 credits", week => expect(week).toEqual({ stopped: 1, ownerTurns: 1, credits: 5.7 })],
  });
  component("an unsettled case counts at the figure it had", {
    given: ["an Esc case with no settled line yet", () => { const path = logPath(); appendCreditStopLine(line("2026-10-30T09:00:00Z", "a", "esc", 1.4), path); return path; }],
    when: ["reading the week", path => readCreditStopWeek({ now: NOW, path })],
    then: ["1.4 credits", week => expect(week).toEqual({ stopped: 1, ownerTurns: 0, credits: 1.4 })],
  });
  unit("no log is a quiet week", {
    given: ["no file", () => join(tmpdir(), "no-such-credit-log.jsonl")],
    when: ["reading the week", path => readCreditStopWeek({ now: NOW, path })],
    then: ["zeros", week => expect(week).toEqual({ stopped: 0, ownerTurns: 0, credits: 0 })],
  });
  unit("amux quota says what the guard did and flags a sum over 5 credits", {
    given: ["a quiet week and a week of 5.7 credits", () => [{ stopped: 0, ownerTurns: 0, credits: 0 }, { stopped: 1, ownerTurns: 1, credits: 5.7 }]],
    when: ["phrasing both", ([quiet, busy]) => [creditStopText(quiet), creditStopText(busy)]],
    then: ["plain words, the limit named", ([quiet, busy]) => {
      expect(quiet).toBe("Codex credit guard, 7 days: no case");
      expect(busy).toBe("Codex credit guard, 7 days: 1 stopped, 1 owner turn left running, 5.7 credits drawn (over the 5 credit limit)");
    }],
  });
});
