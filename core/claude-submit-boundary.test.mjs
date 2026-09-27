import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { claudeCompactRefusalAfterSubmit, hasClaudeCompactBoundaryAfterSubmit } from "./claude-submit-boundary.mjs";

describe("Claude submit epoch boundary", () => {
  it("accepts only a compact boundary newer than the durable submit fence", () => {
    const root = mkdtempSync(join(tmpdir(), "amux-claude-submit-boundary-"));
    const jsonl = join(root, "session.jsonl");
    const cursor = { kind: "claude-prompt-events-v1", positions: { [jsonl]: 0 } };
    try {
      writeFileSync(jsonl, `${JSON.stringify({ type: "system", subtype: "compact_boundary",
        timestamp: new Date(9_999).toISOString() })}\n`);
      expect(hasClaudeCompactBoundaryAfterSubmit(cursor, 10_000)).toBe(false);
      writeFileSync(jsonl, `${JSON.stringify({ type: "system", subtype: "compact_boundary",
        timestamp: new Date(10_001).toISOString() })}\n`);
      expect(hasClaudeCompactBoundaryAfterSubmit(cursor, 10_000)).toBe(true);
      expect(hasClaudeCompactBoundaryAfterSubmit({ kind: "test", positions: { [jsonl]: 0 } },
        10_000)).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("returns Claude's own refusal text only for a failed /compact after the fence", () => {
    const root = mkdtempSync(join(tmpdir(), "amux-claude-compact-refusal-"));
    const jsonl = join(root, "session.jsonl");
    const cursor = { kind: "claude-prompt-events-v1", positions: { [jsonl]: 0 } };
    // The row Claude 2.1.283 wrote on lsrc:2 when the weekly limit refused /compact.
    const refused = (ms) => JSON.stringify({ type: "system", subtype: "local_command",
      commandRun: { command: "compact", args: "" }, commandOutcome: { kind: "failed" },
      content: "<local-command-stderr>Error during compaction: You've hit your weekly limit · resets Sep 30, 9am (Europe/Stockholm)</local-command-stderr>",
      timestamp: new Date(ms).toISOString() });
    try {
      writeFileSync(jsonl, `${refused(9_999)}\n`);
      expect(claudeCompactRefusalAfterSubmit(cursor, 10_000)).toBeNull();
      writeFileSync(jsonl, `${refused(10_001)}\n`);
      expect(claudeCompactRefusalAfterSubmit(cursor, 10_000))
        .toBe("Error during compaction: You've hit your weekly limit · resets Sep 30, 9am (Europe/Stockholm)");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
