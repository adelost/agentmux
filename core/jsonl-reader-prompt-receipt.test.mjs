import { feature, unit, expect } from "bdd-vitest";
import { appendFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { captureClaudePromptEchoCursor, isPromptInJsonl } from "./jsonl-reader.mjs";

const PANE_DIR = "/fake/lsrc/.agents/1";
const line = (content) => `${JSON.stringify({ type: "user", uuid: `u-${content}`, message: { content } })}\n`;

function fakeJournal() {
  const home = mkdtempSync(join(tmpdir(), "amux-prompt-receipt-"));
  const previousHome = process.env.HOME;
  process.env.HOME = home;
  const projectDir = join(home, ".claude", "projects", PANE_DIR.replace(/[/.]/g, "-"));
  mkdirSync(projectDir, { recursive: true });
  const path = join(projectDir, "session-abc123.jsonl");
  writeFileSync(path, line("ship ix") + line("other work"));
  return { path, cleanup: () => { process.env.HOME = previousHome; rmSync(home, { recursive: true, force: true }); } };
}

feature("Claude prompt receipts", () => {
  // defect: 30 Oct a delivery whose cursor lay past its replaced 11.6 MB journal read it whole on every check, 30 MB per 10 s.
  unit("a prompt check reads each appended byte once, even when its cursor lies past the journal's end", {
    given: ["a cursor past the end of a replaced journal, one check, then an old line changed in place and one line appended", () => {
      const journal = fakeJournal();
      const captured = captureClaudePromptEchoCursor(PANE_DIR, "ship it");
      const cursor = { ...captured, positions: { [journal.path]: statSync(journal.path).size + 844_885_374 } };
      const checks = [isPromptInJsonl(PANE_DIR, "ship it", { cursor })];
      // Only a second read of the old bytes can see this prompt; a journal is append-only.
      writeFileSync(journal.path, readFileSync(journal.path, "utf8").replaceAll("ship ix", "ship it"));
      appendFileSync(journal.path, line("more work"));
      checks.push(isPromptInJsonl(PANE_DIR, "ship it", { cursor }));
      appendFileSync(journal.path, line("ship it"));
      return { ...journal, cursor, checks };
    }],
    when: ["the prompt is checked after it was appended", ({ cursor }) => isPromptInJsonl(PANE_DIR, "ship it", { cursor })],
    then: ["only appended bytes count, and the appended prompt is the receipt", (receipt, { checks, cleanup }) => {
      try { expect([...checks, receipt]).toEqual([false, false, true]); }
      finally { cleanup(); }
    }],
  });
});
