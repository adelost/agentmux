import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ensureAgentHints } from "../agent.mjs";

feature("bounded automatic instruction context", () => {
  unit("leaves half the default Codex project budget for repository instructions", {
    when: ["generating the actual shared instruction files", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-hints-budget-"));
      try {
        ensureAgentHints(root);
        return ["AGENTS.md", "CLAUDE.md"].map((name) =>
          readFileSync(join(root, ".agents", name), "utf8"));
      } finally { rmSync(root, { recursive: true, force: true }); }
    }],
    then: ["both engines receive the complete policy without crowding out the repo", ([codex, claude]) => {
      expect(codex).toBe(claude);
      expect(codex).toContain("<!-- amux-hints-end -->");
      // Startup guidance must distinguish historical evidence from current code.
      expect(codex).toMatch(/people, projects and decisions[\s\S]*amux search[\s\S]*--show N/u);
      expect(codex).toMatch(/Current implementation[\s\S]*`rg` and Git[\s\S]*read the source/u);
      expect(codex).toContain("If hits do not answer the question, refine the terms");
      // Byte budget, not a token estimate or a limit on user-owned operator tails.
      expect(Buffer.byteLength(codex, "utf8")).toBeLessThanOrEqual(16 * 1024);
    }],
  });
});
