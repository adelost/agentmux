import { component, expect, feature, unit } from "bdd-vitest";
import { vi } from "vitest";
import { existsSync, mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { openIndex, rankUnits, reindex, semanticModel } from "./search-semantic.mjs";
import { createLiveIndex } from "./search-live-index.mjs";
import { parseGoldenCases } from "./search-eval.mjs";
import { createHumanDir, createLog, MESSAGES, NOW_MS } from "../test/fixtures/conversation-log.mjs";

// A deterministic stand-in for the model: one dimension per keyword.
const KEYWORDS = ["axel", "bumbi", "kassör"];
const fakeEmbed = async (texts) => texts.map((text) => {
  const v = Float32Array.from(KEYWORDS, (word) => (text.toLowerCase().includes(word) ? 1 : 0));
  const norm = Math.hypot(...v) || 1;
  return v.map((x) => x / norm);
});

feature("semantic unit index", () => {
  component("reindex embeds only changed files and a bounded run resumes later", {
    given: ["a memory root with two notes", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-sem-root-"));
      const dir = mkdtempSync(join(tmpdir(), "amux-sem-index-"));
      writeFileSync(join(root, "people.md"), "# People\n**Axel** — systerson\n**Sanna** — kassör\n");
      writeFileSync(join(root, "film.md"), "# Film\n- Bumbi organiserades av Sanna.\n");
      const embedded = [];
      const embed = async (texts, kind) => { embedded.push(...texts); return fakeEmbed(texts, kind); };
      return { roots: [{ name: "memory", path: root, semantic: true, exclude: [], weight: 3 }], root, dir, embed, embedded };
    }],
    when: ["a bounded run, a full run, then a run with nothing changed", async ({ roots, dir, embed, embedded }) => {
      const model = semanticModel("Xenova/multilingual-e5-small");
      const bounded = await reindex(roots, { dir, embed, model, maxUnits: 2 });
      const full = await reindex(roots, { dir, embed, model });
      const before = embedded.length;
      const again = await reindex(roots, { dir, embed, model });
      const index = openIndex(dir);
      const [query] = await fakeEmbed(["vem är kassör"]);
      return { bounded, full, again, newlyEmbedded: embedded.length - before, top: rankUnits(index, query, { k: 1 })[0], complete: index.complete };
    }],
    then: ["the cap defers a file, the next run completes, an unchanged corpus embeds nothing", (result, { root, dir }) => {
      try {
        expect(result.bounded.deferred).toBe(1);
        expect(result.full).toMatchObject({ deferred: 0, chunks: 3 });
        expect(result.again).toMatchObject({ embedded: 0, reused: 3 });
        expect(result.newlyEmbedded).toBe(0);
        expect(result.complete).toBe(true);
        expect(result.top).toMatchObject({ line: 3, layer: "sem" });
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    }],
  });

  component("a note edited after the nightly build is searchable without a reindex", {
    given: ["an index built before today's note grew", async () => {
      const root = mkdtempSync(join(tmpdir(), "amux-live-root-"));
      const dir = mkdtempSync(join(tmpdir(), "amux-live-index-"));
      const path = join(root, "2026-10-10.md");
      writeFileSync(path, "# 2026-10-10\n- Axel fyller år.\n- Bumbi-filmen klar.\n");
      const roots = [{ name: "memory", path: root, semantic: true, exclude: [], weight: 3 }];
      await reindex(roots, { dir, embed: fakeEmbed, model: semanticModel("Xenova/multilingual-e5-small") });
      writeFileSync(path, "# 2026-10-10\n- Axel fyller år.\n- Bumbi-filmen klar.\n- Ny kassör vald i klubben.\n");
      return { root, dir, roots, path };
    }],
    when: ["the daemon's live index refreshes and ranks", async ({ dir, roots }) => {
      const embedded = [];
      const live = createLiveIndex({ dir, scanEveryMs: 0, embed: async (texts, kind) => { embedded.push(...texts); return fakeEmbed(texts, kind); } });
      await live.refresh(roots);
      const [query] = await fakeEmbed(["vem är kassör"]);
      return { embedded, top: live.rank(query, 1)[0] };
    }],
    then: ["only the new bullet is embedded and it ranks with its current offsets", ({ embedded, top }, { root, dir, path }) => {
      try {
        expect(embedded).toEqual([expect.stringContaining("Ny kassör vald i klubben.")]);
        expect(top).toMatchObject({ path, line: 4, indexedSize: statSync(path).size });
      } finally {
        rmSync(root, { recursive: true, force: true });
        rmSync(dir, { recursive: true, force: true });
      }
    }],
  });

  unit("golden sets may carry their provenance in # lines", {
    given: ["a set with a header", () => "# held-out labels are frozen before search\n{\"id\":\"n1\",\"query\":\"q\",\"expect\":[\"a\"],\"split\":\"heldout\",\"asOf\":\"2026-10-10\"}\n"],
    when: ["parsing", (text) => parseGoldenCases(text)],
    then: ["only the case is read, with the day it was written", (cases) => {
      expect(cases).toEqual([{ id: "n1", query: "q", expect: ["a"], kind: "other", split: "heldout", asOf: "2026-10-10" }]);
    }],
  });
});

feature("the semantic index and his messages", () => {
  const humanRootOf = (dir) => ({ name: "human", path: dir, glob: "*.md", exclude: [], semanticExclude: [], weight: 3, semantic: true, kind: "human-words" });
  const world = () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(NOW_MS);
    const log = createLog();
    log.ask(MESSAGES.typed);
    vi.stubEnv("AMUX_ASK_LEDGER_PATH", log.path);
    const human = createHumanDir();
    return { log, human, dir: mkdtempSync(join(tmpdir(), "amux-human-index-")) };
  };
  const end = ({ log, human, dir }) => { vi.useRealTimers(); vi.unstubAllEnvs(); log.remove(); human.remove(); rmSync(dir, { recursive: true, force: true }); };

  component("reindex brings his day files up to date before it embeds the folder", {
    given: ["a log with one message of his, an empty folder for it as a root, and an empty index", world],
    when: ["reindexing with an embedder that records what it embeds", async ({ human, dir }) => {
      const embedded = [];
      const result = await reindex([humanRootOf(human.dir)], { dir, model: semanticModel("Xenova/multilingual-e5-small"),
        embed: async (texts, kind) => { embedded.push(...texts); return fakeEmbed(texts, kind); } });
      return { embedded, result, written: existsSync(join(human.dir, "2026-10-19.md")) };
    }],
    then: ["the day file was written first, and its bullet is in the index with its day as the title", ({ embedded, result, written }, fx) => {
      try {
        expect(written).toBe(true);
        expect(result).toMatchObject({ files: 1, chunks: 1 });
        expect(embedded).toEqual([expect.stringContaining("Human messages, 2026-10-19")]);
        expect(embedded[0]).toContain("- **14:30:00Z lsrc:1** Kör testerna för autocompact nu");
      } finally { end(fx); }
    }],
  });

  component("reindex writes his day files under the name his root carries", {
    given: ["a log with one message of his, and a root for his messages that carries his name", world],
    when: ["reindexing with an embedder that records what it embeds", async ({ human, dir }) => {
      const embedded = [];
      await reindex([{ ...humanRootOf(human.dir), humanName: "Mattias" }], { dir, model: semanticModel("Xenova/multilingual-e5-small"),
        embed: async (texts, kind) => { embedded.push(...texts); return fakeEmbed(texts, kind); } });
      return embedded;
    }],
    then: ["the unit it embeds is headed with his name", (embedded, fx) => {
      try {
        expect(embedded).toHaveLength(1);
        expect(embedded[0]).toContain("- **14:30:00Z Mattias to lsrc:1** Kör testerna för autocompact nu");
      } finally { end(fx); }
    }],
  });

  component("reindex still embeds the notes when the sync of his messages fails, and says so", {
    given: ["a root for his messages whose sync throws, and a note beside it", () => {
      const fx = world();
      const notes = mkdtempSync(join(tmpdir(), "amux-human-notes-"));
      writeFileSync(join(notes, "people.md"), "# People\n**Axel** — systerson\n");
      return { ...fx, notes };
    }],
    when: ["reindexing both roots", async ({ human, dir, notes }) => {
      const logged = [];
      const result = await reindex([{ name: "memory", path: notes, semantic: true, exclude: [], weight: 3 }, humanRootOf(human.dir)],
        { dir, model: semanticModel("Xenova/multilingual-e5-small"), embed: fakeEmbed, log: (line) => logged.push(line),
          syncHuman: () => { throw Object.assign(new Error("ENOSPC: no space left on device"), { code: "ENOSPC" }); } });
      return { logged, result };
    }],
    then: ["the note is indexed and the failure is in the log", ({ logged, result }, fx) => {
      try {
        expect(result).toMatchObject({ files: 1 });
        expect(logged.join("\n")).toContain("ENOSPC");
      } finally { rmSync(fx.notes, { recursive: true, force: true }); end(fx); }
    }],
  });
});
