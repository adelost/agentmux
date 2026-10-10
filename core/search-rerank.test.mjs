import { expect, feature, unit } from "bdd-vitest";
import { blendRerank, rerankText } from "./search-rerank.mjs";

feature("second-stage reranking", () => {
  unit("a strong reranker score lifts a deep candidate without overturning a close call", {
    given: ["four first-stage candidates and reranker scores", () => ({
      candidates: ["first", "second", "third", "deep"].map((path) => ({ path })),
      scores: [2.0, 1.9, -3.0, 6.0],
    })],
    when: ["blending", ({ candidates, scores }) => blendRerank(candidates, scores).map((hit) => hit.path)],
    then: ["the deep answer rises to the top three; first stays above second", (paths) => {
      expect(paths.indexOf("deep")).toBeLessThan(3);
      expect(paths.indexOf("first")).toBeLessThan(paths.indexOf("second"));
    }],
  });

  unit("a topic page is read as its summary and body, without metadata", {
    given: ["a topic hit", () => ({ path: "/topics/memory.md", snippet: "Minne: hur minnet fungerar", topic: { id: "memory" } })],
    when: ["building its text", (hit) => rerankText(hit, () => "---\nsummary: x\nsources:\n  - path: a.md\n    sha256: abc\n---\n<!-- template: ref -->\nJanitor sköter journal-housekeeping.\n")],
    then: ["summary first, then only the body", (text) => expect(text).toBe("Minne: hur minnet fungerar\nJanitor sköter journal-housekeeping.\n")],
  });

  unit("a bullet is read with the entry line and bullets around it", {
    given: ["a bullet under a person entry", () => {
      const text = "## Vänner\n**Smara** — långvarig vän\n- Kommunicerar på engelska\n- Bor i Stockholm\n";
      const start = text.indexOf("- Kommunicerar");
      return { text, hit: { path: "/people.md", snippet: "x", passage: { start, length: "- Kommunicerar på engelska".length,
        context: ["Vänner", "Smara"], section: { start: 0, end: text.length } } } };
    }],
    when: ["building its text", ({ text, hit }) => rerankText(hit, () => text)],
    then: ["the unit comes first, then the entry line and the next bullet", (result) => {
      expect(result).toBe("Vänner > Smara\n- Kommunicerar på engelska\n## Vänner\n**Smara** — långvarig vän\n- Bor i Stockholm");
    }],
  });

  unit("the reranker reads the unit under its headings", {
    given: ["a passage hit inside a people note", () => ({ path: "/people.md", snippet: "x",
      passage: { start: 9, length: 28, context: ["People", "Övriga"] } })],
    when: ["building its text", (hit) => rerankText(hit, () => "# People\n**Julia** — bekant via Hinge\n")],
    then: ["headings first, then the exact unit", (text) => expect(text).toBe("People > Övriga\n**Julia** — bekant via Hinge")],
  });
});
