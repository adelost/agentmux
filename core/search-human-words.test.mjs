import { component, expect, feature, unit } from "bdd-vitest";
import { appendFileSync, chmodSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { vi } from "vitest";
import { isHumanAsk } from "./ask-origin.mjs";
import { acquireFileLease } from "./file-lease.mjs";
import { syncHumanWords } from "./search-human-words.mjs";
import { markdownUnits } from "./search-units.mjs";
import { createHumanDir, createLog, createThreeFileLog, LONG_MESSAGE, MESSAGES, NOW_MS } from "../test/fixtures/conversation-log.mjs";

const sync = (log, human, options = {}) => syncHumanWords({ dir: human.dir, ledgerPath: log.path, nowMs: NOW_MS, ...options });
const dayFiles = (dir) => readdirSync(dir).filter((name) => /^\d{4}-\d{2}-\d{2}\.md$/u.test(name)).sort();
const read = (dir, name) => readFileSync(join(dir, name), "utf8");
const snapshot = (dir) => Object.fromEntries(readdirSync(dir).filter((name) => name !== ".lease").sort().map((name) => [name, read(dir, name)]));
const bullets = (dir) => dayFiles(dir).flatMap((name) => read(dir, name).split("\n").filter((line) => line.startsWith("- **")));
const header = (day) => `# Human messages, ${day}\n\n`;

feature("his messages as day files", () => {
  component("writes each message of his once, word for word", {
    given: ["the three-file log and an empty folder", () => ({ log: createThreeFileLog(), human: createHumanDir() })],
    when: ["syncing twice", ({ log, human }) => {
      const first = sync(log, human);
      const afterFirst = snapshot(human.dir);
      const second = sync(log, human);
      return { first, second, afterFirst, afterSecond: snapshot(human.dir), entries: readdirSync(human.dir).sort() };
    }],
    then: ["one day file per day in the design's format, the voice tag and the wrapper gone, and the second sync changes no byte", (result, { human, log }) => {
      try {
        expect(result.entries).toEqual([".lease", "2026-09-24.md", "2026-10-05.md", "2026-10-06.md", "2026-10-07.md", "2026-10-19.md", "2026-10-20.md", "state.json"]);
        const files = result.afterFirst;
        expect(files["2026-09-24.md"]).toBe(`${header("2026-09-24")}- **10:00:00Z lsrc:0** Kom ihåg att autocompact-gränsen ska vara sjuttio procent\n`);
        // The delivery and its pane-hook copy are one message, written once, at the delivery's time.
        expect(files["2026-10-05.md"]).toBe(`${header("2026-10-05")}- **05:39:58Z api:0** Okej, ja men vi kör Sonnet för genomförandet och Opus planerar\n`);
        expect(files["2026-10-06.md"]).toBe(`${header("2026-10-06")}- **07:15:03Z api:1 voice** Hej, vi behöver autocompact-gränsen dokumenterad\n`);
        expect(files["2026-10-19.md"]).toBe(`${header("2026-10-19")}- **14:30:00Z lsrc:1** Kör testerna för autocompact nu\n`);
        // The row that was half written when the sync looked is not in the file yet.
        expect(files["2026-10-20.md"]).toBe(`${header("2026-10-20")}- **08:00:00Z api:0** Vad sa vi om Sonnet och Opus?\n`);
        expect(result.second).toMatchObject({ written: 0 });
        expect(result.afterSecond).toEqual(result.afterFirst);
        expect(result.first).toMatchObject({ written: 6 });
      } finally { human.remove(); log.remove(); }
    }],
  });

  component("keeps a long message as one bullet whose later lines cannot start a unit of their own", {
    given: ["the three-file log, which holds a message of 2 000 characters with lines that look like list items, a heading and a table row", () =>
      ({ log: createThreeFileLog(), human: createHumanDir() })],
    when: ["syncing, reading the day back as Markdown units", ({ log, human }) => {
      sync(log, human);
      const text = read(human.dir, "2026-10-07.md");
      return { text, units: markdownUnits(text) };
    }],
    then: ["the units are the one bullet, split only where the 1 600-character cap splits it, and removing the indent returns the message", ({ text, units }, { log, human }) => {
      try {
        const lead = "- **09:00:00Z api:2** ";
        const block = text.slice(text.indexOf(lead), text.length - 1);
        expect(text.split("\n").filter((line) => line.startsWith("- **"))).toHaveLength(1);
        expect(units.length).toBe(2);
        expect(units[0].text.startsWith(lead)).toBe(true);
        expect(units.every((unit) => unit.text.length <= 1600)).toBe(true);
        expect(units.map((unit) => unit.text).join("\n")).toBe(block);
        const restored = block.slice(lead.length).split("\n").map((line, index) => (index === 0 ? line : line.replace(/^ {2}/u, ""))).join("\n");
        expect(restored).toBe(LONG_MESSAGE);
      } finally { human.remove(); log.remove(); }
    }],
  });

  component("drops agents' briefs and system wrappers", {
    given: ["the three-file log, with a brief from claw:1, a task notification, posted answers and a message from before the window", () =>
      ({ log: createThreeFileLog(), human: createHumanDir() })],
    when: ["syncing", ({ log, human }) => { sync(log, human); return dayFiles(human.dir).map((name) => read(human.dir, name)).join("\n"); }],
    then: ["none of them is in any day file", (written, { log, human }) => {
      try {
        expect(written).toContain("Sonnet");
        for (const absent of ["Kolla autocompact-statusen", "task-notification", "autocompact-körningen klar", "Noterat, autocompact",
          "Jag kör Sonnet för genomförandet enligt planen", "Gränsen för autocompact sätts", "Gamla beslutet", "claw:1"]) {
          expect(written).not.toContain(absent);
        }
      } finally { human.remove(); log.remove(); }
    }],
  });

  unit("tells a person's message from agents' briefs, wrappers and automation by source and by who wrote it", {
    given: ["rows as the ledger stores them", () => [
      { source: "discord", verbatim: "kan du fixa det här?" },
      { source: "pane-hook", verbatim: "jag skrev det i panelen" },
      { source: "discord", verbatim: "[transcribed voice, may contain speech-to-text errors; interpret intent] hej" },
      { source: "amux-send", sender: "claw:1", verbatim: "[from claw:1] fixa" },
      { source: "discord", verbatim: "[from claw:1] vidarebefordrat" },
      { source: "pane-hook", verbatim: "<task-notification>klar</task-notification>" },
      { source: "pane-hook", verbatim: "/compact" },
      { source: "cli", verbatim: "skrivet i en vanlig terminal" },
      { source: "dream", verbatim: "[dream 2026-10-20 04:00] sammanfatta" },
    ]],
    when: ["asking each", (rows) => rows.map(isHumanAsk)],
    then: ["only the first three are his", (answers) => expect(answers).toEqual([true, true, true, false, false, false, false, false, false])],
  });

  component("merges a delivery with its pane-hook copy", {
    given: ["a delivery, its copy 4 seconds later, a copy 16 minutes later, a second delivery of the same words and a prompt typed in the pane", () => ({
      delivery: MESSAGES.delivery,
      copy: MESSAGES.hookCopy,
      lateCopy: { ...MESSAGES.hookCopy, id: "hook:late", ts: "2026-10-05T05:56:00.000Z" },
      again: { ...MESSAGES.delivery, id: "delivery:again", ts: "2026-10-05T05:42:00.000Z" },
      typed: MESSAGES.typed,
    })],
    when: ["syncing each order of arrival, in one sync or in two", ({ delivery, copy, lateCopy, again, typed }) => {
      const run = (...batches) => {
        const log = createLog();
        const human = createHumanDir();
        try {
          for (const batch of batches) { for (const message of batch) log.ask(message); sync(log, human); }
          return bullets(human.dir);
        } finally { human.remove(); log.remove(); }
      };
      return {
        together: run([delivery, copy]),
        copyFirst: run([copy], [delivery]),
        copyLater: run([delivery], [copy]),
        copyBeforeDeliveryInOneSync: run([copy, delivery]),
        typedOnly: run([typed]),
        pastTheQuarterHour: run([delivery], [lateCopy]),
        twoDeliveries: run([delivery, again]),
      };
    }],
    then: ["a copy within 15 minutes is the same message in either order, and nothing else is merged", (result) => {
      expect(result.together).toEqual(["- **05:39:58Z api:0** Okej, ja men vi kör Sonnet för genomförandet och Opus planerar"]);
      expect(result.copyBeforeDeliveryInOneSync).toEqual(result.together);
      expect(result.copyFirst).toHaveLength(1);
      expect(result.copyLater).toHaveLength(1);
      expect(result.typedOnly).toEqual(["- **14:30:00Z lsrc:1** Kör testerna för autocompact nu"]);
      expect(result.pastTheQuarterHour).toHaveLength(2);
      expect(result.twoDeliveries).toHaveLength(2);
    }],
  });

  component("writes a message once even when the log holds its row twice", {
    given: ["a log where one ask is recorded again later, as a completion receipt is", () => {
      const log = createLog();
      log.ask(MESSAGES.typed);
      log.ask(MESSAGES.typed);
      return { log, human: createHumanDir() };
    }],
    when: ["syncing", ({ log, human }) => { sync(log, human); return bullets(human.dir); }],
    then: ["one bullet", (lines, { log, human }) => {
      try { expect(lines).toHaveLength(1); } finally { human.remove(); log.remove(); }
    }],
  });

  component("adds a message when it arrives, and the half-written one when it is whole", {
    given: ["a first sync of the three-file log, whose last row is half written", () => {
      const log = createThreeFileLog();
      const human = createHumanDir();
      sync(log, human);
      return { log, human, before: snapshot(human.dir) };
    }],
    when: ["the write finishes, one more message arrives, and the folder is synced twice", ({ log, human }) => {
      log.unfinished.finish();
      const arrived = { id: "ask:c5", ts: "2026-10-20T11:59:30.000Z", agent: "lsrc", pane: 2, text: "Ett nytt meddelande efter första synken" };
      log.ask(arrived);
      const second = sync(log, human);
      const afterSecond = snapshot(human.dir);
      const third = sync(log, human);
      return { second, third, afterSecond, afterThird: snapshot(human.dir) };
    }],
    then: ["both are appended after what was there, and the next sync adds nothing", ({ second, third, afterSecond, afterThird }, { log, human, before }) => {
      try {
        expect(second).toMatchObject({ written: 2 });
        const day = "2026-10-20.md";
        expect(afterSecond[day].startsWith(before[day])).toBe(true);
        expect(afterSecond[day].slice(before[day].length)).toBe(
          "- **11:59:00Z api:0** Sista meddelandet om autocompact före åäö-gränsen\n- **11:59:30Z lsrc:2** Ett nytt meddelande efter första synken\n");
        expect(third).toMatchObject({ written: 0 });
        expect(afterThird).toEqual(afterSecond);
      } finally { human.remove(); log.remove(); }
    }],
  });

  component("saves its place in the log only when something about his messages changed or the log moved far", {
    given: ["a synced three-file log, and the identity of the saved state", () => {
      const log = createThreeFileLog();
      const human = createHumanDir();
      sync(log, human);
      const identity = () => { const { ino, mtimeMs } = statSync(join(human.dir, "state.json")); return `${ino}:${mtimeMs}`; };
      return { log, human, identity, saved: identity() };
    }],
    when: ["agents post two short answers, then more than a megabyte of answers, with a sync after each", ({ log, human, identity }) => {
      log.post({ agent: "api", pane: 0, ts: "2026-10-20T11:59:55.000Z", text: "Ett kort svar från en agent", messageId: "m-d1" });
      log.post({ agent: "api", pane: 1, ts: "2026-10-20T11:59:56.000Z", text: "Ett till", messageId: "m-d2" });
      sync(log, human);
      const afterShort = identity();
      for (let n = 0; n < 17; n++) log.post({ agent: "api", pane: 2, ts: "2026-10-20T11:59:57.000Z", text: "x".repeat(65_000), messageId: `m-big-${n}` });
      sync(log, human);
      return { afterShort, afterBig: identity() };
    }],
    then: ["a few answers leave state.json alone, and more than a megabyte of them make the sync save", ({ afterShort, afterBig }, { log, human, saved }) => {
      try {
        expect(afterShort).toBe(saved);
        expect(afterBig).not.toBe(saved);
      } finally { human.remove(); log.remove(); }
    }],
  });

  component("deletes days past the window", {
    given: ["a sync made on 10 September, which kept the 5 September message, and files in the folder that are not day files", () => {
      const log = createThreeFileLog();
      const human = createHumanDir();
      sync(log, human, { nowMs: Date.parse("2026-09-10T00:00:00.000Z") });
      writeFileSync(join(human.dir, "notes.txt"), "stays");
      writeFileSync(join(human.dir, "README.md"), "# stays");
      return { log, human, dayBefore: readdirSync(human.dir).includes("2026-09-05.md") };
    }],
    when: ["syncing on 20 October, whose window starts on 20 September", ({ log, human }) => { sync(log, human); return readdirSync(human.dir).sort(); }],
    then: ["the day before the window is gone, the rest stays, and the state no longer remembers the old message", (entries, { log, human, dayBefore }) => {
      try {
        expect(dayBefore).toBe(true);
        expect(entries).toContain("2026-09-24.md");
        expect(entries).not.toContain("2026-09-05.md");
        expect(entries).toEqual(expect.arrayContaining(["notes.txt", "README.md", "state.json"]));
        const state = JSON.parse(read(human.dir, "state.json"));
        expect(Object.keys(state.keys)).toContain(MESSAGES.inWindowFirst.id);
        expect(Object.keys(state.keys)).not.toContain(MESSAGES.beforeWindow.id);
      } finally { human.remove(); log.remove(); }
    }],
  });

  component("resumes after a failed append without losing a message", {
    given: ["the three-file log, and a disk that is full for the third day file", () => {
      const log = createThreeFileLog();
      const clean = createHumanDir();
      sync(log, clean);
      return { log, clean, human: createHumanDir() };
    }],
    when: ["a sync fails halfway, and the next one runs on a disk with room", ({ log, human }) => {
      let appends = 0;
      const full = (file, text) => {
        if (++appends === 3) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        appendFileSync(file, text);
      };
      let failure = null;
      try { sync(log, human, { append: full }); } catch (error) { failure = error; }
      const stateAfterFailure = readdirSync(human.dir).includes("state.json");
      sync(log, human);
      return { failure, stateAfterFailure };
    }],
    then: ["the failure was raised, no state was saved, and the folder ends up exactly as a sync without a failure leaves it", ({ failure, stateAfterFailure }, { log, human, clean }) => {
      try {
        expect(failure?.code).toBe("ENOSPC");
        expect(stateAfterFailure).toBe(false);
        expect(snapshot(human.dir)).toEqual(snapshot(clean.dir));
      } finally { human.remove(); clean.remove(); log.remove(); }
    }],
  });

  component("changes nothing and says busy while another process holds the lease", {
    given: ["the three-file log and a lease held on the folder", () => {
      const log = createThreeFileLog();
      const human = createHumanDir();
      return { log, human, held: acquireFileLease(join(human.dir, ".lease")) };
    }],
    when: ["syncing while it is held, and again after it is released", ({ log, human, held }) => {
      const busy = sync(log, human);
      const whileHeld = readdirSync(human.dir).sort();
      held.release();
      return { busy, whileHeld, free: sync(log, human) };
    }],
    then: ["the first call wrote nothing, the second wrote the messages", ({ busy, whileHeld, free }, { log, human }) => {
      try {
        expect(busy).toEqual({ busy: true });
        expect(whileHeld).toEqual([".lease"]);
        expect(free).toMatchObject({ written: 6 });
      } finally { human.remove(); log.remove(); }
    }],
  });

  component("keeps the folder and its files private", {
    given: ["a folder that already exists with open permissions, and a day file in it with open permissions", () => {
      const log = createThreeFileLog();
      const human = createHumanDir();
      chmodSync(human.dir, 0o755);
      const day = join(human.dir, "2026-10-19.md");
      writeFileSync(day, `${header("2026-10-19")}`, { mode: 0o644 });
      chmodSync(day, 0o644);
      return { log, human };
    }],
    when: ["syncing", ({ log, human }) => {
      sync(log, human);
      return { dir: statSync(human.dir).mode & 0o777, files: readdirSync(human.dir).map((name) => [name, statSync(join(human.dir, name)).mode & 0o777]) };
    }],
    then: ["the folder is 700 and every file in it 600", ({ dir, files }, { log, human }) => {
      try {
        expect(dir).toBe(0o700);
        expect(files.length).toBeGreaterThan(5);
        for (const [name, mode] of files) expect([name, mode.toString(8)]).toEqual([name, "600"]);
      } finally { human.remove(); log.remove(); }
    }],
  });

  component("starts a new line when a day file ends in the middle of one", {
    given: ["a day file whose last bullet was cut off by a crash", () => {
      const log = createLog();
      log.ask(MESSAGES.typed);
      const human = createHumanDir();
      writeFileSync(join(human.dir, "2026-10-19.md"), `${header("2026-10-19")}- **13:00:00Z lsrc:1** ett halvt med`);
      return { log, human };
    }],
    when: ["syncing", ({ log, human }) => { sync(log, human); return read(human.dir, "2026-10-19.md"); }],
    then: ["his message is a bullet of its own", (text, { log, human }) => {
      try { expect(text).toContain("\n- **14:30:00Z lsrc:1** Kör testerna för autocompact nu\n"); } finally { human.remove(); log.remove(); }
    }],
  });

  component("is off with AMUX_SEARCH_HUMAN=0", {
    given: ["the switch set and the three-file log", () => {
      vi.stubEnv("AMUX_SEARCH_HUMAN", "0");
      return { log: createThreeFileLog(), human: createHumanDir() };
    }],
    when: ["syncing", ({ log, human }) => ({ result: sync(log, human), entries: readdirSync(human.dir) })],
    then: ["nothing is written and the folder stays empty", ({ result, entries }, { log, human }) => {
      try {
        expect(result).toEqual({ disabled: true });
        expect(entries).toEqual([]);
      } finally { vi.unstubAllEnvs(); human.remove(); log.remove(); }
    }],
  });
});
