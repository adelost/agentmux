import { describe, expect, it } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { hasClaudeCompactBoundaryAfterSubmit } from "./claude-submit-boundary.mjs";

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
});
