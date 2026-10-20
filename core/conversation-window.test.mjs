import { component, expect, feature } from "bdd-vitest";
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi } from "vitest";
import { readWindow } from "./ask-ledger.mjs";
import { createConversationWindow } from "./conversation-window.mjs";
import { daemonConversation, serveEmbedder } from "./search-embedder.mjs";
import { searchConversationLog } from "./search-conversation.mjs";
import { syncHumanWords } from "./search-human-words.mjs";
import { createLog, createThreeFileLog, MESSAGES, NOW_MS } from "../test/fixtures/conversation-log.mjs";

const scanOf = (log, nowMs = NOW_MS) => (query, max = 12) => searchConversationLog(query, {
  max, nowMs, read: (range) => readWindow({ path: log.path, ...range }),
});
const windowOf = async (log) => {
  const window = createConversationWindow({ path: log.path, now: () => NOW_MS });
  await window.refresh();
  return window;
};
const ids = (hits) => hits.map((hit) => hit.conversationId);

// 600 rows over 29 days: a small vocabulary where early words are common, 40 distinct instants so many rows tie on
// time and day, and some asks repeated as the pane-hook copies the bridge records.
const manyRowsWorld = async () => {
  const log = createLog();
  let seed = 7;
  const next = () => (seed = (seed * 1664525 + 1013904223) >>> 0) / 2 ** 32;
  const words = ["autocompact", "sonnet", "opus", "budget", "prognos", "kvartal", "testerna", "gröna", "gränsen", "procent", "planen",
    "rapport", "leverans", "hoppet", "vingen", "kupol", "landning", "motvind", "höjd", "pilot", "filmen", "klippet", "musiken", "taktkoll"];
  const instants = Array.from({ length: 40 }, (_, i) => NOW_MS - (29 * 86_400_000) + i * 62_000_000);
  const pick = () => words[Math.floor(next() ** 2 * words.length)];
  for (let n = 0; n < 600; n++) {
    const ts = new Date(instants[Math.floor(next() * instants.length)]).toISOString();
    const text = Array.from({ length: 4 + Math.floor(next() * 4) }, pick).join(" ");
    if (next() < 0.3) {
      const message = { id: `ask:${n}`, ts, agent: "api", pane: n % 3, text };
      log.ask(message);
      if (next() < 0.3) log.ask({ ...message, id: `hook:${n}`, ts: new Date(Date.parse(ts) + 4000).toISOString(), source: "pane-hook" });
    } else log.post({ agent: "api", pane: n % 3, ts, text, messageId: `m-${n}` });
  }
  return { log, window: await windowOf(log), scan: scanOf(log) };
};


// A daemon in this process, over a copy of nothing real: its own home, ledger and folder for his messages, and the
// clock stopped at the fixture's now so the 30-day window holds the fixture's rows.
const daemonWorld = async (prepare = () => {}, serveOptions = {}) => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  const home = mkdtempSync(join(tmpdir(), "daemon-window-"));
  vi.stubEnv("HOME", home);
  vi.stubEnv("AMUX_SEARCH_GPU", "0");
  vi.stubEnv("AMUX_SEARCH_WARM_ROOTS", "");
  const log = createThreeFileLog();
  log.unfinished.finish();
  prepare(log);
  vi.stubEnv("AMUX_ASK_LEDGER_PATH", log.path);
  vi.stubEnv("AMUX_SEARCH_HUMAN_DIR", join(home, "human"));
  const dir = join(home, "index");
  const server = await serveEmbedder({ dir, idleMs: 60_000, exit: () => {},
    load: async () => async () => [[1]],
    loadRanking: async () => ({ score: async () => [1], candidates: 30, weight: 1, kind: "fixture" }), ...serveOptions });
  return { log, home, dir, server };
};
const endDaemonWorld = async ({ log, home, server }) => {
  if (server.listening) await new Promise((resolve) => { server.once("close", resolve); server.close(); });
  vi.useRealTimers();
  vi.unstubAllEnvs();
  log.remove();
  rmSync(home, { recursive: true, force: true });
};

const QUESTIONS = [
  "autocompact", "Sonnet", "Sonnet Opus", "kvartalsrapport", "genomför", "autocomp", "autocompactions", "gränsen", "GRÄNSEN",
  "vad sa", "autocompact sjuttio", "autocompact-gränsen ska vara sjuttio procent", "lsrc:0", "Sonnet?", "och att", "xyzzy",
];

feature("the conversation window in the search daemon", () => {
  component("finds the same rows as the scan", {
    given: ["the three-file log whose half-written row is finished, the window built from it, and the scan over the same files", async () => {
      const log = createThreeFileLog();
      log.unfinished.finish();
      return { log, window: await windowOf(log), scan: scanOf(log) };
    }],
    when: ["asking both the same questions", ({ window, scan }) => QUESTIONS.map((question) =>
      ({ question, scanned: scan(question), windowed: window.search(question, { max: 12 }) }))],
    then: ["each question gets the identical hits in the identical order, and the questions are not all empty", (answers, { log, window, scan }) => {
      try {
        for (const { question, scanned, windowed } of answers) expect({ question, hits: windowed }).toEqual({ question, hits: scanned });
        const by = Object.fromEntries(answers.map(({ question, windowed }) => [question, ids(windowed)]));
        expect(answers.filter(({ scanned }) => scanned.length).length).toBeGreaterThanOrEqual(12);
        // A delivery stands for its pane-hook copy; a task notification and a message before the window are not rows at all.
        expect(by.Sonnet).toContain(MESSAGES.delivery.id);
        for (const question of Object.keys(by)) {
          expect(by[question]).not.toContain(MESSAGES.hookCopy.id);
          expect(by[question]).not.toContain(MESSAGES.notification.id);
          expect(by[question]).not.toContain(MESSAGES.beforeWindow.id);
        }
        expect(window.search("autocompact", { max: 2 })).toEqual(scan("autocompact", 2));
        expect(window.search("autocompact", { max: 2 })).toHaveLength(2);
        expect(window.search("autocompact", { max: 100 })).toEqual(scan("autocompact", 100));
      } finally { log.remove(); }
    }],
  });

  component("finds the same rows as the scan on a log with many equal scores and times", {
    given: ["600 rows of a small vocabulary, many at the same instant, some asks repeated as pane-hook copies", manyRowsWorld],
    when: ["asking common words, word pairs and a prefix, with two limits", ({ window, scan }) =>
      ["autocompact", "sonnet opus", "budget prognos kvartal", "kupol", "landn", "gröna testerna"].flatMap((question) =>
        [5, 12].map((max) => ({ question, max, scanned: scan(question, max), windowed: window.search(question, { max }) })))],
    then: ["the limited answer equals the scan's, rows tied on score and time included", (answers, { log }) => {
      try {
        for (const { question, max, scanned, windowed } of answers) expect({ question, max, hits: windowed }).toEqual({ question, max, hits: scanned });
        expect(answers.every(({ scanned }) => scanned.length > 0)).toBe(true);
      } finally { log.remove(); }
    }],
  });

  component("reads only the lines it needs when the newest days already hold the answer", {
    given: ["the same 600 rows, and a word that a quarter of them hold", manyRowsWorld],
    when: ["asking for the 3 best rows of that word", ({ window }) => window.search("autocompact", { max: 3 })],
    then: ["fewer than a third of the candidate lines were read", (hits, { log }) => {
      try {
        expect(hits).toHaveLength(3);
        expect(hits.cost.candidates).toBeGreaterThan(100);
        expect(hits.cost.linesRead).toBeLessThan(hits.cost.candidates / 3);
      } finally { log.remove(); }
    }],
  });

  component("finds a row appended after warm-up", {
    given: ["a window built from the three-file log", async () => {
      const log = createThreeFileLog();
      log.unfinished.finish();
      return { log, window: await windowOf(log) };
    }],
    when: ["a new message arrives, and the window is asked before and after it reads", async ({ log, window }) => {
      const arrived = { id: "ask:new", ts: "2026-10-20T11:59:50.000Z", agent: "lsrc", pane: 0, text: "Nytt meddelande om kvantkaskaden i kupolen" };
      log.ask(arrived);
      const before = window.search("kvantkaskaden");
      await window.refresh();
      return { before, after: window.search("kvantkaskaden"), scanned: scanOf(log)("kvantkaskaden") };
    }],
    then: ["it is not there until the window reads, and then it is the scan's answer", ({ before, after, scanned }, { log }) => {
      try {
        expect(before).toEqual([]);
        expect(ids(after)).toEqual(["ask:new"]);
        expect(after).toEqual(scanned);
      } finally { log.remove(); }
    }],
  });

  component("keeps its rows when the live file is renamed and a new one starts", {
    given: ["a window built from a log that is then rotated and grows", async () => {
      const log = createLog();
      log.ask(MESSAGES.inWindowFirst);
      const window = await windowOf(log);
      log.ask(MESSAGES.typed);
      log.rotate("2026-10-19T15:00:00.000Z");
      log.ask(MESSAGES.question);
      await window.refresh();
      return { log, window };
    }],
    when: ["asking for rows from before and after the rotation", ({ window, log }) => ({
      old: window.search("autocompact"), scanned: scanOf(log)("autocompact"), fresh: window.search("Sonnet"),
    })],
    then: ["the rows of the renamed file are read from where the file is now", ({ old, scanned, fresh }, { log }) => {
      try {
        expect(ids(old)).toEqual([MESSAGES.typed.id, MESSAGES.inWindowFirst.id]);
        expect(old).toEqual(scanned);
        expect(ids(fresh)).toEqual([MESSAGES.question.id]);
        expect(old.every((hit) => hit.snippet.includes("autocompact"))).toBe(true);
      } finally { log.remove(); }
    }],
  });

  component("the daemon answers op conversation with the rows appended since its last question", {
    given: ["a daemon over the three-file log with a home of its own, and the clock at the fixture's now", () => daemonWorld()],
    when: ["asking, appending his message, and asking again; then asking a daemon that is gone", async ({ log, dir, home, server }) => {
      const first = await daemonConversation("autocompact", { dir });
      log.ask({ id: "ask:new", ts: "2026-10-20T11:59:50.000Z", agent: "lsrc", pane: 0, text: "Nytt meddelande om kvantkaskaden i kupolen" });
      const second = await daemonConversation("kvantkaskaden", { dir });
      const humanDay = readFileSync(join(home, "human", "2026-10-20.md"), "utf8");
      await new Promise((resolve) => { server.once("close", resolve); server.close(); });
      return { first, second, humanDay, gone: await daemonConversation("autocompact", { dir }), scanned: scanOf(log)("autocompact") };
    }],
    then: ["the first answer is the scan's, the second has the new row, his day file holds it, and a daemon that is gone answers null", ({ first, second, humanDay, gone, scanned }, { home }) => {
      expect([...first]).toEqual(scanned);
      expect(ids(second)).toEqual(["ask:new"]);
      expect(humanDay).toContain("- **11:59:50Z lsrc:0** Nytt meddelande om kvantkaskaden i kupolen\n");
      expect(readdirSync(join(home, "human")).filter((name) => name.endsWith(".md"))).toContain("2026-10-05.md");
      expect(gone).toBe(null);
    }],
    cleanup: endDaemonWorld,
  });

  component("the daemon syncs his day files at its first question and when a message of his arrives, not for agents' rows", {
    given: ["a daemon with a recorder around the sync", async () => {
      const calls = [];
      const world = await daemonWorld(() => {}, { syncHuman: (options) => { calls.push(options); return syncHumanWords(options); } });
      return { ...world, calls };
    }],
    when: ["asking, asking again after an agent posted, then asking after a message of his", async ({ log, dir, calls }) => {
      await daemonConversation("autocompact", { dir });
      const afterFirst = calls.length;
      log.post({ agent: "api", pane: 0, ts: "2026-10-20T11:59:55.000Z", text: "Ett svar från en agent om autocompact", messageId: "m-agent" });
      await daemonConversation("autocompact", { dir });
      const afterAgent = calls.length;
      log.ask({ id: "ask:his", ts: "2026-10-20T11:59:58.000Z", agent: "lsrc", pane: 0, text: "Ett meddelande från honom" });
      await daemonConversation("autocompact", { dir });
      return [afterFirst, afterAgent, calls.length];
    }],
    then: ["one sync at the first question, none for the agent's post, one for his message", (syncs) => expect(syncs).toEqual([1, 1, 2])],
    cleanup: endDaemonWorld,
  });

  component("the daemon says when it could not copy his messages, and tries again at the next question", {
    given: ["a daemon whose first sync fails, as on a full disk", async () => {
      const calls = [];
      const world = await daemonWorld(() => {}, { syncHuman: (options) => {
        calls.push(options);
        if (calls.length === 1) throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" });
        return syncHumanWords(options);
      } });
      return { ...world, calls };
    }],
    when: ["asking twice, with nothing new in the log", async ({ dir, home }) => {
      const first = await daemonConversation("autocompact", { dir });
      const second = await daemonConversation("autocompact", { dir });
      return { first: first.warning, second: second.warning, written: readdirSync(join(home, "human")).filter((name) => name.endsWith(".md")).length };
    }],
    then: ["the first answer carries the reason, the second has none and his day files are there", ({ first, second, written }) => {
      expect(first).toContain("ENOSPC");
      expect(second).toBeUndefined();
      expect(written).toBe(6);
    }],
    cleanup: endDaemonWorld,
  });

  component("the daemon answers null when it cannot read the log, and answers again when it can", {
    given: ["a daemon whose live ledger file is unreadable", () => daemonWorld((log) => chmodSync(log.path, 0o000))],
    when: ["asking, making the file readable, and asking again", async ({ log, dir }) => {
      const unreadable = await daemonConversation("autocompact", { dir });
      chmodSync(log.path, 0o600);
      return { unreadable, readable: await daemonConversation("autocompact", { dir }) };
    }],
    then: ["the first answer is null, so the CLI goes on without it, and the second has the rows", ({ unreadable, readable }) => {
      expect(unreadable).toBe(null);
      expect(readable.length).toBeGreaterThan(0);
    }],
    cleanup: endDaemonWorld,
  });
});
