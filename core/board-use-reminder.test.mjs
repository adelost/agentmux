import { unit, feature, expect } from "bdd-vitest";
import { unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { decideBoardReminder, emitBoardUseReminder } from "./board-use-reminder.mjs";

const tmpPath = (suffix) =>
  join(tmpdir(), `amux-board-reminder-test-${Date.now()}-${Math.random().toString(36).slice(2)}${suffix}`);
const cleanup = (p) => { try { unlinkSync(p); } catch {} };

const NOW = 1_785_900_000_000;
const HOUR = 60 * 60 * 1000;

feature("decideBoardReminder cadence", () => {
  unit("first board use ever reminds (empty state is past any silent gap)", {
    given: ["no prior state", () => ({ state: {} })],
    when: ["deciding", ({ state }) => decideBoardReminder(state, NOW)],
    then: ["shows and resets the counter", (r) => {
      expect(r.show).toBe(true);
      expect(r.nextState).toEqual({ usesSinceShown: 0, lastShownAt: NOW });
    }],
  });

  unit("a use shortly after a shown reminder stays silent", {
    given: ["shown one minute ago", () => ({ state: { usesSinceShown: 0, lastShownAt: NOW - 60_000 } })],
    when: ["deciding", ({ state }) => decideBoardReminder(state, NOW)],
    then: ["no show, counter advances, lastShownAt untouched", (r) => {
      expect(r.show).toBe(false);
      expect(r.nextState).toEqual({ usesSinceShown: 1, lastShownAt: NOW - 60_000 });
    }],
  });

  unit("the fifth use since last shown reminds even inside a busy hour", {
    given: ["four silent uses recorded", () => ({ state: { usesSinceShown: 4, lastShownAt: NOW - 60_000 } })],
    when: ["deciding", ({ state }) => decideBoardReminder(state, NOW)],
    then: ["shows and resets", (r) => {
      expect(r.show).toBe(true);
      expect(r.nextState.usesSinceShown).toBe(0);
    }],
  });

  unit("a quiet gap over two hours makes the next single use remind", {
    given: ["one use, last shown three hours ago", () => ({ state: { usesSinceShown: 0, lastShownAt: NOW - 3 * HOUR } })],
    when: ["deciding", ({ state }) => decideBoardReminder(state, NOW)],
    then: ["shows", (r) => expect(r.show).toBe(true)],
  });

  unit("malformed persisted state degrades to first-use behavior, not a crash", {
    given: ["garbage fields", () => ({ state: { usesSinceShown: "NaN?", lastShownAt: null } })],
    when: ["deciding", ({ state }) => decideBoardReminder(state, NOW)],
    then: ["treated as never shown", (r) => expect(r.show).toBe(true)],
  });
});

feature("emitBoardUseReminder side effects", () => {
  unit("writes the reminder text when due and reports true", {
    given: ["a reminder file and fresh state path", () => {
      const textPath = tmpPath(".md");
      const statePath = tmpPath(".json");
      writeFileSync(textPath, "REMINDER BODY\n");
      return { textPath, statePath, written: [] };
    }],
    when: ["emitting", ({ textPath, statePath, written }) => ({
      result: emitBoardUseReminder({
        nowMs: NOW, textPath, statePath, write: (t) => written.push(t),
      }),
      written, textPath, statePath,
    })],
    then: ["true and the body was delivered", ({ result, written, textPath, statePath }) => {
      expect(result).toBe(true);
      expect(written).toEqual(["REMINDER BODY\n"]);
      cleanup(textPath); cleanup(statePath);
    }],
  });

  unit("a missing reminder file never throws and never blocks the board call", {
    given: ["no text file", () => ({ textPath: tmpPath(".missing.md"), statePath: tmpPath(".json") })],
    when: ["emitting", ({ textPath, statePath }) => ({
      result: emitBoardUseReminder({ nowMs: NOW, textPath, statePath, write: () => {} }),
      statePath,
    })],
    then: ["false, no exception", ({ result, statePath }) => {
      expect(result).toBe(false);
      cleanup(statePath);
    }],
  });
});
