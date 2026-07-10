import { unit, component, feature, expect } from "bdd-vitest";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadSearchRoots, escapeRegex, snippetPattern, cleanSnippet, dateFromPath,
  scoreHit, dedupeByFile, runRg, filesWithAllWords, lexicalSearch,
  renderJsonlLine, expandHit, formatHits, withScore,
} from "./search.mjs";
import { chunkMarkdown } from "./search-semantic.mjs";

feature("search config — roots from agents.yaml", () => {
  unit("normalizes paths, weights and flags", {
    given: ["a config with one root", () => ({ search: { roots: [
      { name: "memory", path: "~/ws/memory", glob: "*.md", weight: 3, semantic: true },
      { path: "/abs/path" },
    ] } })],
    when: ["loading", (c) => loadSearchRoots(c)],
    then: ["tilde expanded, defaults applied", (roots) => {
      expect(roots[0].path).toBe(join(process.env.HOME, "ws/memory"));
      expect(roots[0].weight).toBe(3);
      expect(roots[0].semantic).toBe(true);
      expect(roots[1].name).toBe("/abs/path");
      expect(roots[1].weight).toBe(1);
    }],
  });

  unit("missing search section means no roots (caller hints, no crash)", {
    given: ["an agents-only config", () => ({ claw: { dir: "/x" } })],
    when: ["loading", (c) => loadSearchRoots(c)],
    then: ["empty", (roots) => { expect(roots).toEqual([]); }],
  });
});

feature("pattern building — word boundaries kill the substring noise", () => {
  unit("query is regex-escaped inside the boundary pattern", {
    given: ["a query with regex chars", () => "amux (search)"],
    when: ["building", (q) => snippetPattern(q)],
    then: ["escaped + bounded + snippet window", (p) => {
      expect(p).toContain("\\bamux \\(search\\)\\b");
      expect(p).toMatch(/^\.\{0,60\}/);
    }],
  });

  unit("escapeRegex neutralizes every metachar", {
    given: ["metachars", () => "a.b*c?d(e)f[g]h|i$j^k"],
    when: ["escaping", (s) => escapeRegex(s)],
    then: ["compiles to a literal-matching regex", (s) => {
      expect(new RegExp(s).test("a.b*c?d(e)f[g]h|i$j^k")).toBe(true);
    }],
  });
});

feature("snippet + date helpers", () => {
  unit("jsonl escapes collapse to readable text", {
    given: ["a raw jsonl fragment", () => 'hej\\nvi ses\\t\\"imorgon\\"  '],
    when: ["cleaning", (s) => cleanSnippet(s)],
    then: ["single-spaced prose", (s) => {
      expect(s).toBe('hej vi ses "imorgon"');
    }],
  });

  unit("date comes from the filename when present", {
    given: ["a daily file path", () => "/ws/memory/2026-05-10.md"],
    when: ["extracting", (p) => dateFromPath(p)],
    then: ["the date", (d) => { expect(d).toBe("2026-05-10"); }],
  });
});

feature("ranking — source weight dominates, then layer, then recency", () => {
  const now = Date.parse("2026-07-10");
  const hit = (over) => ({ weight: 1, layer: "L1", date: "2026-07-01", matches: 1, ...over });

  unit("memory (weight 3) outranks a session hit (weight 1) regardless of layer", {
    given: ["a memory L2 hit vs a session L1 hit", () => [
      hit({ weight: 3, layer: "L2" }),
      hit({ weight: 1, layer: "L1" }),
    ]],
    when: ["scoring both", (hits) => hits.map((h) => scoreHit(h, now))],
    then: ["memory wins", ([mem, ses]) => { expect(mem).toBeGreaterThan(ses); }],
  });

  unit("same source: exact phrase beats word-AND", {
    given: ["L1 vs L2 same weight/date", () => [hit({ layer: "L1" }), hit({ layer: "L2" })]],
    when: ["scoring", (hits) => hits.map((h) => scoreHit(h, now))],
    then: ["L1 wins", ([l1, l2]) => { expect(l1).toBeGreaterThan(l2); }],
  });

  unit("same source+layer: fresh beats stale", {
    given: ["this week vs last year", () => [
      hit({ date: "2026-07-08" }), hit({ date: "2025-07-08" }),
    ]],
    when: ["scoring", (hits) => hits.map((h) => scoreHit(h, now))],
    then: ["fresh wins", ([fresh, stale]) => { expect(fresh).toBeGreaterThan(stale); }],
  });

  unit("ten matches in one transcript collapse to one overview row", {
    given: ["three hits in the same file, one elsewhere", () => [
      { path: "/a.md", score: 5, matches: 1 },
      { path: "/a.md", score: 7, matches: 1 },
      { path: "/a.md", score: 6, matches: 1 },
      { path: "/b.md", score: 4, matches: 1 },
    ]],
    when: ["deduping", (hits) => dedupeByFile(hits)],
    then: ["best per file, sorted", (out) => {
      expect(out.length).toBe(2);
      expect(out[0].path).toBe("/a.md");
      expect(out[0].score).toBe(7);
    }],
  });
});

feature("jsonl rendering — --show is readable, not raw JSON", () => {
  unit("claude session line renders role + text", {
    given: ["a user event line", () => JSON.stringify({
      timestamp: "2026-05-10T09:00:00Z",
      message: { role: "user", content: "vad sa Tess om lönen?" },
    })],
    when: ["rendering", (l) => renderJsonlLine(l)],
    then: ["USER prefix + text", (r) => {
      expect(r).toContain("USER:");
      expect(r).toContain("vad sa Tess");
    }],
  });

  unit("ledger event renders event + pane", {
    given: ["a delivery row", () => JSON.stringify({
      ts: "2026-07-10T06:00:00Z", event: "delivery", session: "lsrc", pane: 1, detail: "/compact",
    })],
    when: ["rendering", (l) => renderJsonlLine(l)],
    then: ["event line", (r) => {
      expect(r).toContain("delivery");
      expect(r).toContain("lsrc:1");
    }],
  });

  unit("tool-result noise (no text) renders as null, not garbage", {
    given: ["an event without text content", () => JSON.stringify({
      message: { role: "user", content: [{ type: "tool_result", content: "x" }] },
    })],
    when: ["rendering", (l) => renderJsonlLine(l)],
    then: ["null", (r) => { expect(r).toBeNull(); }],
  });
});

feature("chunkMarkdown — heading-aware, line-anchored", () => {
  unit("splits at headings and remembers start lines", {
    given: ["a two-section doc", () => "# A\ntext om första sektionen här, tillräckligt lång\n\n# B\nandra sektionens text, också tillräckligt lång"],
    when: ["chunking", (t) => chunkMarkdown(t, { maxChars: 100 })],
    then: ["two chunks with 1-based lines", (chunks) => {
      expect(chunks.length).toBe(2);
      expect(chunks[0].line).toBe(1);
      expect(chunks[1].line).toBe(4);
      expect(chunks[1].text).toContain("# B");
    }],
  });

  unit("tiny fragments are dropped (nothing useful to embed)", {
    given: ["a doc with a stub section", () => "# X\nok\n# Y\nen riktig sektion med faktiskt innehåll som är värd att indexera"],
    when: ["chunking", (t) => chunkMarkdown(t)],
    then: ["only the real section survives", (chunks) => {
      expect(chunks.length).toBe(1);
      expect(chunks[0].text).toContain("riktig sektion");
    }],
  });
});

feature("end-to-end lexical over a real temp corpus (rg integration)", () => {
  const corpus = () => {
    const dir = mkdtempSync(join(tmpdir(), "amux-search-"));
    writeFileSync(join(dir, "2026-05-10.md"), "# Lönesamtal\nMattias pratade med Tess om 80/20-modellen.\n");
    writeFileSync(join(dir, "notes.md"), "Cirklar är redan tessellaterade med 48 segment.\n");
    writeFileSync(join(dir, "other.md"), "Tess läser det måndag. Tess svarar tisdag.\n");
    return dir;
  };

  component("word boundary excludes 'tessellaterade' (the benchmark bug)", {
    given: ["corpus with the trap word", corpus],
    when: ["searching Tess", (dir) => {
      const hits = lexicalSearch("Tess", [{ name: "mem", path: dir, glob: "*.md", exclude: [], weight: 3 }]);
      rmSync(dir, { recursive: true, force: true });
      return hits;
    }],
    then: ["hits in the right files only, deduped per file", (hits) => {
      const files = hits.map((h) => h.path.split("/").pop()).sort();
      expect(files).toEqual(["2026-05-10.md", "other.md"]);
    }],
  });

  component("multi-word query falls back to file-level AND (L2)", {
    given: ["corpus where words never share a line", () => {
      const dir = mkdtempSync(join(tmpdir(), "amux-search-"));
      writeFileSync(join(dir, "doc.md"), "Tess nämnde modellen.\nSenare kom frågan om åttio-tjugo.\n");
      writeFileSync(join(dir, "off.md"), "Tess utan det andra ordet.\n");
      return dir;
    }],
    when: ["searching 'Tess åttio-tjugo'", (dir) => {
      const hits = lexicalSearch("Tess åttio-tjugo", [{ name: "mem", path: dir, glob: "*.md", exclude: [], weight: 3 }]);
      rmSync(dir, { recursive: true, force: true });
      return hits;
    }],
    then: ["doc.md found via L2, off.md excluded", (hits) => {
      expect(hits.length).toBe(1);
      expect(hits[0].path.endsWith("doc.md")).toBe(true);
      expect(hits[0].layer).toBe("L2");
    }],
  });

  component("expandHit marks the hit line in context", {
    given: ["a file and a hit on line 3", () => {
      const dir = mkdtempSync(join(tmpdir(), "amux-search-"));
      const p = join(dir, "x.md");
      writeFileSync(p, "rad1\nrad2\nTRÄFFEN\nrad4\n");
      return { dir, hit: { path: p, line: 3 } };
    }],
    when: ["expanding", ({ dir, hit }) => {
      const out = expandHit(hit, { context: 2 });
      rmSync(dir, { recursive: true, force: true });
      return out;
    }],
    then: ["arrow on the hit line", (out) => {
      expect(out).toContain("▶ TRÄFFEN");
      expect(out).toContain("  rad1");
    }],
  });
});
