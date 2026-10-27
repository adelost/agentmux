import { expect, feature, integration } from "bdd-vitest";
import { vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdClaims } from "./claims.mjs";
import { inferAskOrigin, isHumanAsk } from "../core/ask-origin.mjs";

feature("claim measurement keeps actual reply identity and excludes incoming messages", () => {
  integration("automatic correction prompts are not new human asks", {
    given: ["one correction observed by both queue and pane hook", () => "[amux claim-guard correction for turn-one]\nHeld: add a source"],
    when: ["classifying the two real producer shapes", prompt => [
      inferAskOrigin({ source: "claim-guard", prompt }), isHumanAsk({ source: "pane-hook", verbatim: prompt }),
    ]],
    then: ["the prompt remains automation", values => expect(values).toEqual(["system", false])],
  });
  integration("the normal CLI reads only canonical sent reply rows", {
    given: ["a private tiny mixed ledger", () => {
      const dir = mkdtempSync(join(tmpdir(), "claim-cli-")), path = join(dir, "ledger.jsonl");
      const base = { version: 1, ts: "2026-10-27T01:00:00Z", agent: "fixture", pane: 0, text: "Testerna är gröna.", status: "sent" };
      writeFileSync(path, [
        { ...base, event: "ask", id: "human", verbatim: "Testerna är gröna." },
        { ...base, event: "post", kind: "reply", id: "original-reply" },
        { ...base, event: "post", kind: "file", id: "file" },
        { ...base, event: "post", kind: "reply", id: "failed-reply", status: "failed" },
      ].map(row => JSON.stringify(row)).join("\n"));
      return { dir, path, quiet: vi.spyOn(console, "log").mockImplementation(() => {}) };
    }],
    when: ["checking through the CLI contract", async fixture => ({ ...fixture,
      report: await cmdClaims(["check", "--day", "2026-10-27", "--ledger", fixture.path, "--repo", fixture.dir]) })],
    then: ["it preserves the one original reply and cannot enable without review", ({ report }) => {
      expect(report.rows.map(row => row.id)).toEqual(["original-reply"]);
      expect(report.held).toBe(1); expect(report.eligible).toBe(false); expect(report.falseStopRate).toBeNull();
    }],
    cleanup: ({ dir, quiet }) => { quiet.mockRestore(); rmSync(dir, { recursive: true, force: true }); },
  });
});
