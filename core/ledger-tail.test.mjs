import { component, expect, feature, unit } from "bdd-vitest";
import { statSync } from "node:fs";
import { basename } from "node:path";
import { readRange, tailLedger } from "./ledger-tail.mjs";
import { createLog, createThreeFileLog, MESSAGES } from "../test/fixtures/conversation-log.mjs";

// The tail reads the real files of the fixture log; only the byte reader is wrapped, to see what it was asked for.
const recorded = (log, extra = {}) => {
  const reads = [];
  const read = (file, offset, length) => { reads.push({ name: basename(file), offset, length }); return readRange(file, offset, length); };
  return { reads, options: { path: log.path, read, ...extra } };
};
const message = (n) => ({ id: `ask:${n}`, ts: `2026-10-20T10:0${n}:00.000Z`, agent: "api", pane: 0, text: `meddelande ${n} åäö` });
const ids = (tailed) => tailed.rows.map(({ row }) => row.id);

feature("the tail of the conversation log", () => {
  component("reads only bytes appended since the last call", {
    given: ["a log of two asks, and a reader that records what it is asked for", () => {
      const log = createLog();
      log.ask(message(1)); log.ask(message(2));
      return { log, ...recorded(log) };
    }],
    when: ["tailing, appending one ask, and tailing twice more", ({ log, options }) => {
      const first = tailLedger({}, options);
      const sizeAfterFirst = statSync(log.path).size;
      log.ask(message(3));
      const second = tailLedger(first.state, options);
      const sizeAfterSecond = statSync(log.path).size;
      const third = tailLedger(second.state, options);
      return { first, second, third, sizeAfterFirst, sizeAfterSecond };
    }],
    then: ["each call read from where the last one stopped, and a call with nothing new read nothing", (result, { log, reads }) => {
      try {
        expect(ids(result.first)).toEqual(["ask:1", "ask:2"]);
        expect(ids(result.second)).toEqual(["ask:3"]);
        expect(ids(result.third)).toEqual([]);
        expect(reads).toEqual([
          { name: "ask-ledger.jsonl", offset: 0, length: result.sizeAfterFirst },
          { name: "ask-ledger.jsonl", offset: result.sizeAfterFirst, length: result.sizeAfterSecond - result.sizeAfterFirst },
        ]);
      } finally { log.remove(); }
    }],
  });

  component("follows a rotated file by inode", {
    given: ["a tail that has read the live file, which then gets another row, is renamed and replaced", () => {
      const log = createLog();
      log.ask(message(1)); log.ask(message(2));
      const { reads, options } = recorded(log);
      const first = tailLedger({}, options);
      const inode = String(statSync(log.path).ino);
      const sizeBeforeRotation = statSync(log.path).size;
      log.ask(message(3));
      const archive = log.rotate("2026-10-20T10:30:00.000Z");
      log.ask(message(4));
      return { log, reads, options, first, inode, archive, sizeBeforeRotation };
    }],
    when: ["tailing again", ({ first, options }) => tailLedger(first.state, options)],
    then: ["the renamed file is read from its saved offset and the new file from the start, each row once", (second, fx) => {
      try {
        expect(ids(second)).toEqual(["ask:3", "ask:4"]);
        expect(fx.reads.slice(1)).toEqual([
          { name: basename(fx.archive), offset: fx.sizeBeforeRotation, length: statSync(fx.archive).size - fx.sizeBeforeRotation },
          { name: "ask-ledger.jsonl", offset: 0, length: statSync(fx.log.path).size },
        ]);
        expect(second.state[fx.inode]).toMatchObject({ path: fx.archive, offset: statSync(fx.archive).size });
        expect(Object.keys(second.state)).toHaveLength(2);
      } finally { fx.log.remove(); }
    }],
  });

  component("keeps a partial line until it ends", {
    given: ["a log whose last row is cut inside a two-byte letter", () => {
      const log = createLog();
      log.ask(message(1));
      return { log, unfinished: log.partial(MESSAGES.late), ...recorded(log) };
    }],
    when: ["tailing, letting the write finish, and tailing twice more", ({ log, unfinished, options }) => {
      const before = tailLedger({}, options);
      unfinished.finish();
      const after = tailLedger(before.state, options);
      const again = tailLedger(after.state, options);
      return { before, after, again, size: statSync(log.path).size };
    }],
    then: ["the row appears once, whole and unchanged, when its newline has arrived", ({ before, after, again, size }, { log }) => {
      try {
        expect(ids(before)).toEqual(["ask:1"]);
        const [key] = Object.keys(before.state);
        expect(before.state[key].offset).toBeLessThan(before.state[key].size);
        expect(ids(after)).toEqual([MESSAGES.late.id]);
        expect(after.rows[0].row.verbatim).toBe(MESSAGES.late.text);
        expect(after.state[key]).toMatchObject({ offset: size, size });
        expect(again.rows).toEqual([]);
      } finally { log.remove(); }
    }],
  });

  component("reads a rewritten file again", {
    given: ["a tail that has read three rows of the live file, which is then rewritten shorter", () => {
      const log = createLog();
      for (const n of [1, 2, 3]) log.ask(message(n));
      const { reads, options } = recorded(log);
      const first = tailLedger({}, options);
      const rewritten = { version: 1, event: "ask", ts: "2026-10-20T10:09:00.000Z", id: "ask:again", agent: "api", pane: 0, source: "discord", verbatim: "ny text" };
      log.rewrite([rewritten]);
      return { log, reads, options, first, size: statSync(log.path).size };
    }],
    when: ["tailing again", ({ first, options }) => tailLedger(first.state, options)],
    then: ["the file is read from the start and flagged, so the caller can drop what it held", (second, { log, reads, size }) => {
      try {
        expect(second.rewritten).toBe(true);
        expect(ids(second)).toEqual(["ask:again"]);
        expect(reads.at(-1)).toEqual({ name: "ask-ledger.jsonl", offset: 0, length: size });
      } finally { log.remove(); }
    }],
  });

  component("opens no archive that ends before the window and reports where each row sits", {
    given: ["the three-file log, whose oldest archive ends on 24 September", () => ({ log: createThreeFileLog() })],
    when: ["tailing it for the window that starts on 1 October", ({ log }) => {
      const { reads, options } = recorded(log, { sinceMs: Date.parse("2026-10-01T00:00:00.000Z") });
      const tailed = tailLedger({}, options);
      const lines = tailed.rows.map(({ path, offset, length }) => readRange(path, offset, length).toString("utf8"));
      return { tailed, reads, lines };
    }],
    then: ["only the later two files are read, and each row's bytes are its own line", ({ tailed, reads, lines }, { log }) => {
      try {
        expect(new Set(reads.map((read) => read.name)).size).toBe(2);
        expect(reads.every((read) => !read.name.includes("2026-10-02T06"))).toBe(true);
        expect(lines.map((line) => JSON.parse(line).id)).toEqual(ids(tailed));
        expect(ids(tailed)).toContain(MESSAGES.long.id);
        expect(ids(tailed)).not.toContain(MESSAGES.inWindowFirst.id);
      } finally { log.remove(); }
    }],
  });

  component("reads a large log in slices that add up to one read", {
    given: ["the three-file log and a slice smaller than its longest row", () => {
      const log = createThreeFileLog();
      log.unfinished.finish();
      return { log };
    }],
    when: ["tailing in slices of 700 bytes until done, then once more, and once without a limit", ({ log }) => {
      const sliced = [];
      let state = {};
      let calls = 0;
      for (let done = false; !done && calls < 100; calls++) {
        const tailed = tailLedger(state, { path: log.path, maxBytes: 700 });
        sliced.push(...tailed.rows);
        state = tailed.state;
        done = tailed.done;
      }
      return { sliced, calls, after: tailLedger(state, { path: log.path, maxBytes: 700 }), whole: tailLedger({}, { path: log.path }) };
    }],
    then: ["the same rows come out, at the same places, and a finished state reads nothing more", ({ sliced, calls, after, whole }, { log }) => {
      try {
        expect(calls).toBeGreaterThan(3);
        expect(calls).toBeLessThan(100);
        expect(sliced.map(({ row, offset, length }) => [row.id, offset, length]))
          .toEqual(whole.rows.map(({ row, offset, length }) => [row.id, offset, length]));
        expect(whole.done).toBe(true);
        expect(after.rows).toEqual([]);
      } finally { log.remove(); }
    }],
  });

  unit("a file that vanished between listing and reading is left out", {
    given: ["a listing with one file that cannot be read", () => ({
      files: () => [{ file: "/gone/ask.jsonl", firstMs: -Infinity, lastMs: Infinity }],
      stat: () => { throw Object.assign(new Error("gone"), { code: "ENOENT" }); },
    })],
    when: ["tailing", (options) => tailLedger({}, options)],
    then: ["nothing is returned and nothing is remembered", (tailed) => {
      expect(tailed).toMatchObject({ rows: [], state: {}, done: true, rewritten: false });
    }],
  });
});
