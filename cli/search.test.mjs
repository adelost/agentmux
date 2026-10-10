import { component, expect, feature, unit } from "bdd-vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { vi } from "vitest";
import { cmdSearch } from "./search.mjs";

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
