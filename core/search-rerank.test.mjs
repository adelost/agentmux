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

  unit("the reranker reads the unit under its headings", {
    given: ["a passage hit inside a people note", () => ({ path: "/people.md", snippet: "x",
      passage: { start: 9, length: 28, context: ["People", "Övriga"] } })],
    when: ["building its text", (hit) => rerankText(hit, () => "# People\n**Julia** — bekant via Hinge\n")],
    then: ["headings first, then the exact unit", (text) => expect(text).toBe("People > Övriga\n**Julia** — bekant via Hinge")],
  });
});
