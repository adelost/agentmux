import { expect, feature, unit } from "bdd-vitest";
import { servedTopics } from "./memory-topic-search.mjs";

const topic = (id, action) => ({ path: `/w/memory/topics/${id}.md`, action, sha256: "a".repeat(64), state: action === "SERVE" ? "CURRENT" : "STALE",
  cell: "c", meta: { id, title: `T ${id}`, summary: `S ${id}`, asOf: "2026-10-10", aliases: [] } });

feature("served topics for the rerank pool", () => {
  unit("every servable topic page is offered, whatever the question says", {
    given: ["one served, one withheld and one unreadable topic", () => [topic("browser", "SERVE"), topic("old", "WITHHOLD"), { path: "/x", meta: null }]],
    when: ["listing served topics", (topics) => servedTopics("/w", { topics })],
    then: ["only the served page, as a topic hit", (hits) => {
      expect(hits).toHaveLength(1);
      expect(hits[0]).toMatchObject({ path: "/w/memory/topics/browser.md", layer: "topic", coversQuery: false, snippet: "T browser: S browser" });
    }],
  });
});
