import { expect, feature, unit } from "bdd-vitest";
import { documentWindow, firstAnswerRank, formatEvalReport, parseGoldenCases, summarizeEval } from "./search-eval.mjs";

const golden = [
  '{"id":"q1","kind":"decision","split":"dev","query":"auto-push av minnet","expect":["Auto-push-cron avstådd"]}',
  '{"id":"q2","kind":"exact","split":"heldout","query":"Tess","expect":["Tess"]}',
].join("\n");

feature("golden-set search evaluation", () => {
  unit("cases need an id, a query and expected answer text", {
    when: ["parsing a valid set and a case without answers", () => ({
      cases: parseGoldenCases(golden),
      broken: () => parseGoldenCases('{"id":"x","query":"q","expect":[]}'),
    })],
    then: ["valid cases keep kind and split; an unanswerable case is rejected", ({ cases, broken }) => {
      expect(cases.map(row => [row.id, row.kind, row.split])).toEqual([["q1", "decision", "dev"], ["q2", "exact", "heldout"]]);
      expect(broken).toThrow(/expect/);
    }],
  });

  unit("an answer counts wherever the file now lives, but only when it is in view", {
    given: ["the same note before and after archiving, and an unrelated hit", () => {
      const note = ["# 2026-08-04", "", ...Array(40).fill("- annat"), "- Auto-push-cron avstådd medvetet."].join("\n");
      const files = { "/m/2026-08-04.md": note, "/m/archive/daily/2026-08-04.md": note };
      return { viewOf: hit => documentWindow(hit.path, hit.line, { readFile: path => files[path] }) };
    }],
    when: ["ranking hits that point near and far from the answer line", ({ viewOf }) => ({
      archived: firstAnswerRank([{ path: "/m/2026-08-04.md", line: 1 }, { path: "/m/archive/daily/2026-08-04.md", line: 43 }], ["auto-push-cron AVSTÅDD"], { viewOf }),
      outOfView: firstAnswerRank([{ path: "/m/2026-08-04.md", line: 1 }], ["Auto-push-cron avstådd"], { viewOf }),
    })],
    then: ["the archived copy answers at rank 2; a hit 40 lines away does not", ({ archived, outOfView }) => {
      expect(archived).toBe(2);
      expect(outOfView).toBeNull();
    }],
  });

  unit("summary reports hit@k, MRR and latency per kind", {
    when: ["summarizing four results", () => summarizeEval([
      { kind: "exact", rank: 1, ms: 100 }, { kind: "exact", rank: 4, ms: 300 },
      { kind: "people", rank: 2, ms: 200 }, { kind: "people", rank: null, ms: 400 },
    ])],
    then: ["numbers follow the definitions", summary => {
      expect(summary.overall).toMatchObject({ n: 4, hit1: 0.25, hit3: 0.5, medianMs: 200, p95Ms: 400 });
      expect(summary.overall.mrr).toBeCloseTo((1 + 0.25 + 0.5) / 4);
      expect(Object.keys(summary.byKind)).toEqual(["exact", "people"]);
    }],
  });

  unit("the report lists every rank and explains each miss", {
    when: ["formatting a run with one miss", () => formatEvalReport({ label: "golden dev", summary: summarizeEval([
      { kind: "exact", rank: 1, ms: 10 }, { kind: "exact", rank: null, ms: 20 }]),
    rows: [{ id: "q1", rank: 1, query: "a", top: ["L1 /x:1"] }, { id: "q2", rank: null, query: "b", top: [] }] })],
    then: ["ranks and the miss with its top hits are visible", report => {
      expect(report).toContain("Ranks: q1=1 q2=-");
      expect(report).toContain('q2 miss  "b"');
    }],
  });
});
