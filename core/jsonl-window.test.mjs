import { unit, feature, expect } from "bdd-vitest";
import { writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { readTailWindow, parseJsonlWindow } from "./jsonl-reader.mjs";

// Bounded tail-window reading for session jsonl that outgrows Node's max string
// length. The window logic (newline-alignment, UTF-8 boundary, growing window,
// empty / small file) is the unit here; the >512MB crash itself is covered
// empirically against the real giant file.

const tmpPath = () =>
  join(tmpdir(), `amux-jsonl-win-${Date.now()}-${Math.random().toString(36).slice(2)}.jsonl`);
const write = (content) => { const p = tmpPath(); writeFileSync(p, content); return { p }; };
const cleanup = (p) => { try { unlinkSync(p); } catch {} };
const manyLines = (n) => Array.from({ length: n }, (_, i) => JSON.stringify({ i })).join("\n") + "\n";

feature("readTailWindow", () => {
  unit("a file smaller than the window returns the whole file and reachedStart", {
    given: ["a small jsonl", () => write('{"a":1}\n{"a":2}\n')],
    when: ["reading with a large window", ({ p }) => readTailWindow(p, 1024 * 1024)],
    then: ["reachedStart is true and the full text comes back", (r, { p }) => {
      expect(r.reachedStart).toBe(true);
      expect(r.text).toBe('{"a":1}\n{"a":2}\n');
      cleanup(p);
    }],
  });

  unit("a window smaller than the file drops the partial leading line", {
    given: ["a jsonl whose first line the window slices into", () => write('PARTIAL_FIRST_LINE\n{"b":2}\n{"b":3}\n')],
    when: ["reading a 16-byte tail", ({ p }) => readTailWindow(p, 16)],
    then: ["reachedStart false, the partial first line is gone, the tail survives", (r, { p }) => {
      expect(r.reachedStart).toBe(false);
      expect(r.text.includes("PARTIAL_FIRST_LINE")).toBe(false);
      expect(r.text.includes('{"b":3}')).toBe(true);
      cleanup(p);
    }],
  });

  unit("an empty file yields empty text and reachedStart", {
    given: ["an empty file", () => write("")],
    when: ["reading", ({ p }) => readTailWindow(p, 1024)],
    then: ["empty text, reachedStart true", (r, { p }) => {
      expect(r.text).toBe("");
      expect(r.reachedStart).toBe(true);
      cleanup(p);
    }],
  });

  unit("a multibyte char sliced at the window start never begins a kept line", {
    // "ααα…" pads a multibyte first line so a tiny window cuts mid-codepoint;
    // that partial line is dropped, so the kept tail is valid UTF-8 JSON.
    given: ["a multibyte first line + a clean tail line", () => write('{"x":"ααααααααααα"}\n{"y":2}\n')],
    when: ["reading a tail window that cuts into the first line", ({ p }) => readTailWindow(p, 12)],
    then: ["kept text is the clean tail line, parseable", (r, { p }) => {
      expect(r.reachedStart).toBe(false);
      expect(r.text.trim()).toBe('{"y":2}');
      cleanup(p);
    }],
  });
});

feature("parseJsonlWindow", () => {
  unit("a single window suffices when enough is met by the initial read", {
    given: ["a 20-line jsonl", () => write(manyLines(20))],
    when: ["parsing with a big-enough initial window", ({ p }) => parseJsonlWindow(p, { initialBytes: 1024 * 1024 })],
    then: ["all events parsed", (evs, { p }) => {
      expect(evs.length).toBe(20);
      cleanup(p);
    }],
  });

  unit("the window grows until enough events are captured", {
    given: ["a 200-line jsonl", () => write(manyLines(200))],
    when: ["parsing with a tiny initial window needing >=150 events", ({ p }) =>
      parseJsonlWindow(p, { initialBytes: 32, enough: (e) => e.length >= 150 })],
    then: ["it doubled the window until >=150 events were present", (evs, { p }) => {
      expect(evs.length >= 150).toBe(true);
      cleanup(p);
    }],
  });

  unit("it stops at the file start when the need exceeds the file", {
    given: ["a 10-line jsonl", () => write(manyLines(10))],
    when: ["asking for more events than exist", ({ p }) =>
      parseJsonlWindow(p, { initialBytes: 16, enough: (e) => e.length >= 9999 })],
    then: ["it returns all available events (reached file start, no infinite loop)", (evs, { p }) => {
      expect(evs.length).toBe(10);
      cleanup(p);
    }],
  });
});
