import { component, expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { vi } from "vitest";
import { cmdSearch, collectSearchHits } from "./search.mjs";
import { createHumanDir, createThreeFileLog, NOW_MS } from "../test/fixtures/conversation-log.mjs";

// The semantic layer needs a model and a daemon; these tests pin the lexical
// contract, so the layer reports itself unavailable instead of starting one.
const noSemantic = { query: async () => ({ hits: [], unavailable: "semantic layer disabled in tests" }), passages: async () => null,
  rerank: async () => ({ scores: null, unavailable: "reranker disabled in tests" }) };

const runSearch = async (files, query, flags, makeSemantic = () => noSemantic) => {
  const root = mkdtempSync(join(tmpdir(), "amux-search-cli-case-"));
  const configPath = join(root, "config.yaml");
  writeFileSync(configPath, JSON.stringify({ search: { roots: [{ name: "memory", path: root, glob: "*.md", semantic: true }] } }));
  for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
  writeFileSync(join(root, "events.jsonl"), "");
  const previous = process.env.AMUX_EVENTS_PATH;
  process.env.AMUX_EVENTS_PATH = join(root, "events.jsonl");
  const output = vi.spyOn(console, "log").mockImplementation(() => {});
  const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
  try {
    await cmdSearch({ configPath }, query, { workspace: root, ...flags }, { statePath: join(root, "result.json"), semantic: makeSemantic(root) });
    return { text: output.mock.calls.flat().join("\n"), warned: warnings.mock.calls.flat().join("\n") };
  } finally {
    output.mockRestore();
    warnings.mockRestore();
    if (previous === undefined) delete process.env.AMUX_EVENTS_PATH;
    else process.env.AMUX_EVENTS_PATH = previous;
    rmSync(root, { recursive: true, force: true });
  }
};

feature("search CLI contract", () => {
  component("a natural question retrieves the original answer paragraph", {
    given: ["a current memory note, not a matching full question", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-search-answer-"));
      const configPath = join(root, "config.yaml");
      writeFileSync(configPath, JSON.stringify({ search: { roots: [
        { name: "memory", path: root, glob: "*.md", semantic: true },
      ] } }));
      writeFileSync(join(root, "notes.md"), "# Vardagen\n\nNär jag städade hjälpte ljudboken. Social kontakt minskade ensamheten.\n");
      writeFileSync(join(root, "events.jsonl"), "");
      return { root, configPath };
    }],
    when: ["asking and opening the first source", async ({ root, configPath }) => {
      const previous = process.env.AMUX_EVENTS_PATH;
      process.env.AMUX_EVENTS_PATH = join(root, "events.jsonl");
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await cmdSearch({ configPath }, "Vad hjälpte mig när jag städade och kände mig ensam?", {
          workspace: root, show: "1", max: 3,
        }, { statePath: join(root, "result.json"), semantic: noSemantic });
        return output.mock.calls.flat().join("\n");
      } finally {
        output.mockRestore();
        if (previous === undefined) delete process.env.AMUX_EVENTS_PATH;
        else process.env.AMUX_EVENTS_PATH = previous;
      }
    }],
    then: ["the actual helpful actions and original source are returned", (text, { root }) => {
      try {
        expect(text).toContain("ljudboken");
        expect(text).toContain("Social kontakt minskade ensamheten");
        expect(text).toContain(join(root, "notes.md"));
      } finally { rmSync(root, { recursive: true, force: true }); }
    }],
  });

  component("a question about yesterday answers from yesterday's note", {
    given: ["today's note matches the words better than yesterday's", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-search-time-"));
      const configPath = join(root, "config.yaml");
      writeFileSync(configPath, JSON.stringify({ search: { roots: [{ name: "memory", path: root, glob: "*.md", semantic: true }] } }));
      writeFileSync(join(root, "2026-10-10.md"), "# 2026-10-10\n- WSL startade om, WSL startade om igen.\n");
      writeFileSync(join(root, "2026-10-09.md"), "# 2026-10-09\n- Kvällen: WSL startade om efter uppdateringen och allt kom tillbaka.\n");
      writeFileSync(join(root, "events.jsonl"), "");
      return { root, configPath };
    }],
    when: ["asking about yesterday on 2026-10-10", async ({ root, configPath }) => {
      const previous = process.env.AMUX_EVENTS_PATH;
      process.env.AMUX_EVENTS_PATH = join(root, "events.jsonl");
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await cmdSearch({ configPath }, "när startade WSL om i går", { workspace: root, max: 2, now: "2026-10-10T12:00:00" },
          { statePath: join(root, "result.json"), semantic: noSemantic });
        return output.mock.calls.flat().join("\n");
      } finally {
        output.mockRestore();
        if (previous === undefined) delete process.env.AMUX_EVENTS_PATH;
        else process.env.AMUX_EVENTS_PATH = previous;
      }
    }],
    then: ["yesterday's note is the first hit", (text, { root }) => {
      try {
        expect(text.split("\n").find((line) => line.startsWith("# 1"))).toContain("2026-10-09.md");
      } finally { rmSync(root, { recursive: true, force: true }); }
    }],
  });

  component("an identifier named in many notes opens the unit that decides it, not the newest mention", {
    given: ["an older decision and a newer passing mention", () => ({
      "2026-10-09.md": "# 2026-10-09\n- BESLUT: IMPORT_FLAG av i produktion.\n",
      "2026-10-10.md": `# 2026-10-10\n- ${"Lång statusrad om releaser och prover. ".repeat(12)}Nämner IMPORT_FLAG i förbifarten.\n`,
    })],
    when: ["looking the identifier up", (files) => runSearch(files, "IMPORT_FLAG", { max: 2 })],
    then: ["the decision is the first hit", ({ text }) => {
      expect(text.split("\n").find((line) => line.startsWith("# 1"))).toContain("2026-10-09.md");
    }],
  });

  component("a reranker running on the CPU instead of the GPU is said, not hidden", {
    given: ["a warm daemon whose reranker fell back to the CPU", () => {
      const note = "no CUDA libraries in ~/.cache/agentmux/cuda; CPU reranker in use";
      const text = "# Anteckningar\n- Ljudboken hjälpte vid städningen.\n";
      return { note, files: { "notes.md": text }, makeSemantic: (root) => ({
        query: async () => {
          const info = statSync(join(root, "notes.md"));
          return { hits: [{ path: join(root, "notes.md"), line: 2, root: "memory", weight: 3, date: null, sim: 0.5,
            unit: { start: 15, length: 33, section: { start: 0, end: text.length } }, indexedMtimeMs: info.mtimeMs, indexedSize: info.size }],
          reranker: { kind: "cpu", candidates: 30, perFile: 2, semanticK: 30, note } };
        },
        passages: async () => null,
        rerank: async (query, texts) => ({ scores: texts.map(() => 1), weight: 0.3, kind: "cpu", note }),
      }) };
    }],
    when: ["asking a natural question", ({ files, makeSemantic }) => runSearch(files, "vad hjälpte vid städningen", { max: 2 }, makeSemantic)],
    then: ["the fallback is in the output", ({ warned }, { note }) => expect(warned).toContain(note)],
  });

  component("dense retrieval's top hits reach the reranker even when lexical units fill the budget", {
    given: ["120 lexical matches and an English answer only the dense layer finds, at dense rank 45", () => {
      const files = {};
      for (let f = 0; f < 20; f++) files[`n${f}.md`] = `# N${f}\n${Array.from({ length: 6 }, (_, i) => `- Ljudboken hjälpte vid städningen, del ${f}.${i}.`).join("\n")}\n`;
      const other = Array.from({ length: 60 }, (_, i) => `- Line ${i} about something else entirely.`);
      other[44] = "- Shortcut OK if the end result is realistic.";
      files["english.md"] = `# English\n${other.join("\n")}\n`;
      const judged = [];
      const makeSemantic = (root) => ({
        query: async () => {
          const text = files["english.md"];
          const info = statSync(join(root, "english.md"));
          const hits = other.map((line, i) => ({ path: join(root, "english.md"), line: i + 2, root: "memory", weight: 3, date: null,
            sim: 0.9 - i * 0.005, unit: { start: text.indexOf(line), length: line.length, section: { start: 0, end: text.length } },
            indexedMtimeMs: info.mtimeMs, indexedSize: info.size }));
          return { hits, reranker: { kind: "gpu", candidates: 100, perFile: 6, semanticK: 60, note: null } };
        },
        passages: async () => null,
        rerank: async (query, texts) => { judged.push(...texts); return { scores: texts.map(() => 0), weight: 1, kind: "gpu" }; },
      });
      return { files, makeSemantic, judged };
    }],
    when: ["asking a question that shares no word with the answer", ({ files, makeSemantic }) =>
      runSearch(files, "ljudboken städningen fuska fysiken", { max: 3 }, makeSemantic)],
    then: ["the reranker judged the English line", (_, { judged }) => {
      expect(judged.some((text) => text.includes("Shortcut OK if the end result is realistic."))).toBe(true);
    }],
  });

  component("--eval --profile reports stage timings and whether answers reached the reranker", {
    given: ["a golden set with one question", () => ({
      "notes.md": "# Anteckningar\n- Ljudboken hjälpte vid städningen.\n",
      "golden.jsonl": `${JSON.stringify({ id: "q1", query: "vad hjälpte vid städningen", expect: ["Ljudboken hjälpte"], split: "dev" })}\n`,
    })],
    when: ["profiling the eval", async (files) => {
      const root = mkdtempSync(join(tmpdir(), "amux-search-profile-"));
      for (const [name, text] of Object.entries(files)) writeFileSync(join(root, name), text);
      const result = await runSearch(files, "", { eval: join(root, "golden.jsonl"), split: "dev", profile: true });
      rmSync(root, { recursive: true, force: true });
      return result;
    }],
    then: ["a per-stage table and the pool-recall line are printed", ({ text }) => {
      expect(text).toMatch(/Stage timings:[\s\S]*lexical +n= *1/u);
      expect(text).toContain("Pool recall:");
    }],
  });

  unit("help is handled before config access", {
    when: ["requesting help without a CLI context", async () => {
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      await cmdSearch({}, "", { help: true });
      const text = output.mock.calls.flat().join("\n");
      output.mockRestore();
      return text;
    }],
    then: ["usage explains both history modes", (text) => {
      expect(text).toContain("amux search \"term\" --show N");
      expect(text).toContain("durable AMUX delivery ledger");
    }],
  });

  component("one invocation searches and expands a durable delivery", {
    given: ["a legacy config without a ledger root and one delivered request", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-search-cli-"));
      const configPath = join(root, "agentmux.yaml");
      const eventsPath = join(root, "events.jsonl");
      writeFileSync(configPath, "search:\n  roots: []\nagents: {}\n");
      writeFileSync(eventsPath, JSON.stringify({
        ts: "2026-07-20T21:41:47Z",
        event: "delivery_queue",
        state: "enqueued",
        session: "skyvw",
        pane: 6,
        jobId: "sundial-request",
        detail: "Skriv klockan ovanför soluret så tiden blir kompakt.",
      }));
      return { root, configPath, eventsPath, statePath: join(root, "search-state.json") };
    }],
    when: ["searching a paraphrase with --show", async (fixture) => {
      const previous = process.env.AMUX_EVENTS_PATH;
      process.env.AMUX_EVENTS_PATH = fixture.eventsPath;
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      try {
        await cmdSearch({ configPath: fixture.configPath }, "flytta in klockan i soluret", {
          fast: true,
          show: "1",
        }, { statePath: fixture.statePath, semantic: noSemantic });
        return { fixture, text: output.mock.calls.flat().join("\n") };
      } finally {
        output.mockRestore();
        if (previous === undefined) delete process.env.AMUX_EVENTS_PATH;
        else process.env.AMUX_EVENTS_PATH = previous;
      }
    }],
    then: ["the exact receipt is shown from the ledger", ({ fixture, text }) => {
      expect(text).toContain("Skriv klockan ovanför soluret");
      expect(text).toContain("skyvw:6");
      rmSync(fixture.root, { recursive: true, force: true });
    }],
  });
});

// The conversation log is searched by the warm daemon; a cold answer leaves it out (docs/DESIGN-search-daemon.md, chapter 2).
// It does not say the daemon is starting: a start refused for lack of memory made that false.
const COLD_WARNING = "ℹ conversation log is searched by the warm search daemon, which is not up; this answer leaves it out";

// The root of his day files, as the design shapes it; cmdSearch adds it by itself (last test below).
const humanRootOf = (path) => ({ name: "human", path, glob: "*.md", exclude: [], semanticExclude: [], weight: 3, semantic: true, kind: "human-words" });

const conversationWorld = async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(NOW_MS);
  const log = createThreeFileLog();
  log.unfinished.finish();
  const human = createHumanDir();
  vi.stubEnv("AMUX_ASK_LEDGER_PATH", log.path);
  vi.stubEnv("AMUX_SEARCH_HUMAN_DIR", human.dir);
  return { log, human, roots: [humanRootOf(human.dir)], workspace: human.dir };
};
const endWorld = ({ log, human }) => { vi.useRealTimers(); vi.unstubAllEnvs(); human.remove(); log.remove(); };
const ask = (world, query, flags, semantic) => {
  const warned = [];
  return collectSearchHits(query, world.roots, world.workspace, flags, { warn: (message) => warned.push(message), semantic })
    .then((result) => ({ ...result, warned }));
};

feature("the conversation log in the search CLI", () => {
  component("uses the daemon's conversation hits when it is warm", {
    given: ["a warm daemon that answers with one row, while the log itself holds another row with the same words", async () => {
      const world = await conversationWorld();
      const fromDaemon = { path: "/daemon/ledger", line: 0, root: "conversation", weight: 2, layer: "L1", date: "2026-10-20", timestamp: "2026-10-20T07:00:00.000Z",
        conversationId: "row-from-the-daemon", agent: "api", pane: 0, eventKind: "post", dedupeKey: "conversation:row-from-the-daemon", matches: 4, score: 9,
        snippet: "Svaret om genomförandet enligt planen kom från daemonens minne" };
      const asked = [];
      const semantic = { ...noSemantic, conversation: async (query, options) => { asked.push({ query, ...options }); return [fromDaemon]; } };
      return { ...world, asked, semantic };
    }],
    when: ["asking for those words", (world) => ask(world, "Sonnet genomförandet enligt planen", { lexical: true }, world.semantic)],
    then: ["the daemon was asked once for at most 12 rows, its row is in the answer, the log was not scanned, and nothing says the log was left out", (result, world) => {
      try {
        expect(world.asked).toHaveLength(1);
        expect(world.asked[0]).toMatchObject({ query: "Sonnet genomförandet enligt planen", max: 12 });
        expect(result.top.filter((hit) => hit.conversationId).map((hit) => hit.conversationId)).toEqual(["row-from-the-daemon"]);
        expect(result.warned.join("\n")).not.toContain("conversation log is searched");
      } finally { endWorld(world); }
    }],
  });

  component("leaves the scan out when cold unless --source conversation", {
    given: ["the three-file log and no warm daemon", async () => {
      const world = await conversationWorld();
      return { ...world, semantic: { ...noSemantic, conversation: async () => null } };
    }],
    when: ["asking the same words cold, then with --source conversation, then with --source human", async (world) => ({
      cold: await ask(world, "Sonnet genomförandet enligt planen", { lexical: true }, world.semantic),
      named: await ask(world, "Sonnet genomförandet enligt planen", { source: "conversation" }, world.semantic),
      human: await ask(world, "Sonnet genomförandet enligt planen", { source: "human" }, world.semantic),
    })],
    then: ["the cold answer warns in the exact words, has none of the agents' rows and still finds his message; naming the log scans it", ({ cold, named, human }, world) => {
      try {
        expect(cold.warned).toContain(COLD_WARNING);
        expect(cold.top.some((hit) => hit.conversationId)).toBe(false);
        expect(cold.top.some((hit) => hit.path.endsWith("2026-10-05.md"))).toBe(true);
        expect(named.warned).not.toContain(COLD_WARNING);
        expect(named.top.some((hit) => hit.conversationId && hit.snippet.includes("enligt planen"))).toBe(true);
        expect(human.warned).not.toContain(COLD_WARNING);
        expect(human.top.every((hit) => !hit.conversationId)).toBe(true);
        expect(human.top.some((hit) => hit.path.endsWith("2026-10-05.md"))).toBe(true);
      } finally { endWorld(world); }
    }],
  });

  component("starts the daemon when a lookup finds it cold, unless the reader asked for lexical search", {
    given: ["no warm daemon and a recorder for its start", async () => {
      const world = await conversationWorld();
      const starts = [];
      return { ...world, starts, semantic: { ...noSemantic, conversation: async () => null, start: (options) => starts.push(options) } };
    }],
    when: ["looking up one word, then the same with --lexical", async (world) => {
      await ask(world, "Sonnet", {}, world.semantic);
      const afterLookup = world.starts.length;
      await ask(world, "Sonnet", { lexical: true }, world.semantic);
      return { afterLookup, afterLexical: world.starts.length };
    }],
    then: ["the lookup started it once, with the roots to warm, and the lexical question did not", ({ afterLookup, afterLexical }, world) => {
      try {
        expect(afterLookup).toBe(1);
        expect(world.starts[0].roots.map((root) => root.name)).toEqual(["human"]);
        expect(afterLexical).toBe(1);
      } finally { endWorld(world); }
    }],
  });

  component("every search sees his day files as a root, with no configuration", {
    given: ["a config with no roots, the three-file log and a folder for his messages", async () => {
      const world = await conversationWorld();
      const configPath = join(world.human.dir, "config.yaml");
      writeFileSync(configPath, "search:\n  roots: []\nagents: {}\n");
      return { ...world, configPath };
    }],
    when: ["asking through the command", async (world) => {
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await cmdSearch({ configPath: world.configPath }, "Sonnet genomförandet", { lexical: true, workspace: world.workspace },
          { statePath: join(world.human.dir, "result.json"), semantic: { ...noSemantic, conversation: async () => null } });
        return output.mock.calls.flat().join("\n");
      } finally { output.mockRestore(); warnings.mockRestore(); }
    }],
    then: ["his message of 5 October is in the answer", (text, world) => {
      try {
        expect(text).toContain("2026-10-05.md");
        expect(text).toContain("Opus planerar");
      } finally { endWorld(world); }
    }],
  });

  component("writes his name from human.name in his day files, and tells the daemon the name with the question", {
    given: ["a config with human.name, the three-file log and a folder for his messages", async () => {
      const world = await conversationWorld();
      const configPath = join(world.human.dir, "config.yaml");
      writeFileSync(configPath, "human:\n  name: Mattias\nsearch:\n  roots: []\nagents: {}\n");
      return { ...world, configPath, asked: [] };
    }],
    when: ["asking through the command while no daemon answers", async (world) => {
      const output = vi.spyOn(console, "log").mockImplementation(() => {});
      const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
      try {
        await cmdSearch({ configPath: world.configPath }, "Sonnet genomförandet", { lexical: true, workspace: world.workspace },
          { statePath: join(world.human.dir, "result.json"),
            semantic: { ...noSemantic, conversation: async (query, options) => { world.asked.push(options); return null; } } });
        return readFileSync(join(world.human.dir, "2026-10-05.md"), "utf8");
      } finally { output.mockRestore(); warnings.mockRestore(); }
    }],
    then: ["his message is written under his name, and the question to the daemon carried the name", (day, world) => {
      try {
        expect(day).toContain("- **05:39:58Z Mattias to api:0** Okej, ja men vi kör Sonnet för genomförandet och Opus planerar");
        expect(world.asked.map((options) => options.humanName)).toEqual(["Mattias"]);
      } finally { endWorld(world); }
    }],
  });
});

// A question for his words lists his units first (docs/DESIGN-search-daemon.md v9: UC-7, I-5, R-9). The world is made up:
// the reranker puts two agents' notes above one unit of his, and the warm daemon adds a conversation row, so his unit is
// the last of four until the question asks for him.
const HIS_WORDS_QUESTION = "vad sa Mattias om lyktschemat";
const TODAYS_ORDER = ["conversation row", "agent note", "agent summary", "his unit"];
const conversationRow = { path: "/daemon/ask-ledger.jsonl", line: 0, root: "conversation", weight: 2, layer: "L1", date: "2026-10-20",
  timestamp: "2026-10-20T07:00:00.000Z", conversationId: "row-quoting-him", agent: "api", pane: 0, eventKind: "post",
  dedupeKey: "conversation:row-quoting-him", matches: 4, score: 9, snippet: "api:0 skrev att Mattias sa att lyktschemat ska ligga kvar" };

const hisWordsWorld = () => {
  const human = createHumanDir();
  const notes = mkdtempSync(join(tmpdir(), "amux-search-his-words-"));
  const units = [
    ["agent note", notes, "memory", "agent-note.md", "api:0 antecknade att Mattias sa att lyktschemat ska ligga kvar.", 3],
    ["agent summary", notes, "memory", "agent-summary.md", "api:1 sammanfattade att lyktschemat ligger kvar enligt Mattias.", 2],
    ["his unit", human.dir, "human", "2026-10-20.md", "**09:00:00Z Mattias to api:0** Lyktschemat ska ligga kvar som det är.", 1],
  ].map(([label, dir, root, file, bullet, score], rank) => {
    const path = join(dir, file);
    const text = `# 2026-10-20\n- ${bullet}\n`;
    writeFileSync(path, text);
    const info = statSync(path);
    const start = text.indexOf("\n") + 1;
    return { label, path, bullet, score, dense: { path, line: 2, root, weight: 3, date: "2026-10-20", sim: 0.9 - rank * 0.1,
      unit: { start, length: text.length - start - 1, section: { start: 0, end: text.length } }, indexedMtimeMs: info.mtimeMs, indexedSize: info.size } };
  });
  // The first stage is empty on purpose: the reranker judges the three dense hits and nothing the lexical layer would add.
  const semantic = {
    query: async () => ({ hits: units.map((unit) => unit.dense), reranker: { kind: "gpu", candidates: 30, perFile: 2, semanticK: 30, note: null } }),
    passages: async () => [],
    rerank: async (_question, texts) => ({ scores: texts.map((text) => units.find((unit) => text.includes(unit.bullet))?.score ?? 0), weight: 1, kind: "gpu" }),
    conversation: async () => [conversationRow],
  };
  const labelOf = (hit) => hit.conversationId ? "conversation row" : units.find((unit) => unit.path === hit.path)?.label ?? hit.path;
  const rootsFor = (name) => [
    { name: "memory", path: notes, glob: "*.md", exclude: [], semanticExclude: [], weight: 3, semantic: true, kind: null },
    { ...humanRootOf(human.dir), ...(name ? { humanName: name } : {}) },
  ];
  return { human, notes, semantic, labelOf, rootsFor };
};
const endHisWordsWorld = (world) => { world.human.remove(); rmSync(world.notes, { recursive: true, force: true }); };
const askForHisWords = (world, question, { name = "Mattias", ...flags } = {}) =>
  collectSearchHits(question, world.rootsFor(name), world.notes, flags, { warn: () => {}, semantic: world.semantic, syncHuman: () => {} })
    .then(({ top }) => top.map(world.labelOf));

feature("a question for his words in the search CLI", () => {
  component("puts his units above agent rows for a question for his words", {
    given: ["two agent notes and a conversation row that the ranking puts above one unit of his", hisWordsWorld],
    when: ["asking for his words with his name configured, and the same question with none", async (world) => ({
      named: await askForHisWords(world, HIS_WORDS_QUESTION),
      unnamed: await askForHisWords(world, HIS_WORDS_QUESTION, { name: "" }),
    })],
    then: ["without his name the row and both notes lead as before; with it his unit is first and all four stay", ({ named, unnamed }, world) => {
      try {
        expect(unnamed).toEqual(TODAYS_ORDER);
        expect(named).toEqual(["his unit", "conversation row", "agent note", "agent summary"]);
      } finally { endHisWordsWorld(world); }
    }],
  });

  component("keeps the order of every other question", {
    given: ["the same world, with his name configured", hisWordsWorld],
    when: ["asking what an agent noted, another pane's words, and the words of a person whose name only contains his", async (world) => {
      const orders = [];
      for (const question of ["vad antecknade api:0 om lyktschemat", "vad sa api:0 om lyktschemat", "vad sa Mattiasson om lyktschemat"]) {
        orders.push(await askForHisWords(world, question));
      }
      return orders;
    }],
    then: ["each keeps today's order, with his unit last", (orders, world) => {
      try { for (const order of orders) expect(order).toEqual(TODAYS_ORDER); } finally { endHisWordsWorld(world); }
    }],
  });

  component("reaches a unit of his that the cut would drop when the question is for his words", {
    given: ["the same world and a list cut to two hits", hisWordsWorld],
    when: ["asking for his words with --max 2, with his name configured and with none", async (world) => ({
      named: await askForHisWords(world, HIS_WORDS_QUESTION, { max: 2 }),
      unnamed: await askForHisWords(world, HIS_WORDS_QUESTION, { max: 2, name: "" }),
    })],
    then: ["without his name his unit is cut off; with it his unit leads the cut list", ({ named, unnamed }, world) => {
      try {
        expect(unnamed).toEqual(["conversation row", "agent note"]);
        expect(named).toEqual(["his unit", "conversation row"]);
      } finally { endHisWordsWorld(world); }
    }],
  });
});
