import { expect, feature, integration } from "bdd-vitest";
import { vi } from "vitest";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cmdClaims } from "./claims.mjs";

feature("claim measurement keeps actual reply identity and excludes incoming messages", () => {
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
