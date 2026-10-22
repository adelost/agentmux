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
      // Search ranks by match, so the human's latest words need the time-ordered ledger first (lsrc:0, 2026-10-22).
      expect(codex).toMatch(/amux asks --list --since 12h -n 100`[\s\S]*before `amux search`/u);
      // Automatic log/Dream policy replaces the retired manual day-writing trigger (lsrc:0, 2026-10-21).
      for (const trigger of ["Before a merge or release", "Before handing work on", "Before changing a hot function", "Before a compact", "Memory or day digests", "Delivering images or speech"]) {
        expect(codex).toContain(trigger);
      }
      expect(codex).not.toContain("Writing the day file");
      for (const heading of ["Always lead with a recommendation", "First line is the outcome", "Root cause > symptoms"]) {
        expect(codex).not.toContain(`## ${heading}`);
      }
      expect(codex).toContain("No skill names or bracketed labels in replies.");
      expect(codex).toContain("Comments explain intent, risks or constraints, not a work diary.");
      expect(codex).toContain("Preserve requirement scope and source pointers; never copy human quotations.");
      expect(codex).toContain("Never skip a failing test or bypass a hook with `--no-verify`.");
      expect(codex).toContain("On a `[drift-guard]` reminder, re-read the section it names.");
      // Byte budget, not a token estimate or a limit on user-owned operator tails.
      // 2026-10-21: lsrc:0's register brief moves the full rules behind read triggers.
      expect(Buffer.byteLength(codex, "utf8")).toBeLessThanOrEqual(8 * 1024);
    }],
  });
});
