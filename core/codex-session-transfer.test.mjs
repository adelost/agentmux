import { feature, integration, expect } from "bdd-vitest";
import { transferCodexSession } from "./codex-session-transfer.mjs";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

feature("exact one-session transfer between authenticated Codex account homes", () => {
  for (const kind of ["missing", "older-prefix", "divergent", "target-writer"]) {
    integration(`${kind} preserves both account histories`, {
      given: ["one isolated original session and target account", () => {
        const root = mkdtempSync(join(tmpdir(), "amux-session-transfer-"));
        const current = { home: join(root, "one") }, target = { home: join(root, "two") };
        const from = join(current.home, "sessions", "2026", "10", "12", "rollout-session.jsonl");
        const to = join(target.home, "sessions", "2026", "10", "12", "rollout-session.jsonl");
        mkdirSync(join(current.home, "sessions", "2026", "10", "12"), { recursive: true });
        mkdirSync(join(target.home, "sessions", "2026", "10", "12"), { recursive: true });
        writeFileSync(from, "original\nnewer\n");
        if (kind !== "missing") writeFileSync(to, kind === "divergent" ? "different\n" : "original\n");
        return { root, current, target, from, to };
      }],
      when: ["transferring exact bytes without authentication data", fx => transferCodexSession("/pane", fx.current, fx.target, {
        discover: () => ({ sessionId: "exact", path: fx.from }), writers: () => kind === "target-writer" ? [100] : [] })],
      then: ["only absent or verified older copies receive the current session", (result, fx) => {
        expect(readFileSync(fx.from, "utf8")).toBe("original\nnewer\n");
        expect(result.ok).toBe(["missing", "older-prefix"].includes(kind));
        expect(readFileSync(fx.to, "utf8")).toBe(kind === "divergent" ? "different\n" : kind === "target-writer" ? "original\n" : "original\nnewer\n");
        expect(existsSync(join(fx.target.home, "auth.json"))).toBe(false);
      }], cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
    });
  }
});
