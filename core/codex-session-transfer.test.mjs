import { feature, integration, expect } from "bdd-vitest";
import { transferCodexSession } from "./codex-session-transfer.mjs";
import { mkdirSync, mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

feature("exact one-session transfer between authenticated Codex account homes", () => {
  const sessionId = "11111111-1111-4111-8111-111111111111";
  const metadata = cwd => JSON.stringify({ type: "session_meta", payload: { id: sessionId, cwd } }) + "\n";
  const original = metadata("/pane") + '{"type":"event_msg","payload":{"type":"user_message","message":"original"}}\n';
  const newer = '{"type":"event_msg","payload":{"type":"user_message","message":"newer"}}\n';
  for (const kind of ["missing", "older-prefix", "divergent", "target-writer"]) {
    integration(`${kind} preserves both account histories`, {
      given: ["one isolated original session and target account", () => {
        const root = mkdtempSync(join(tmpdir(), "amux-session-transfer-"));
        const current = { home: join(root, "one") }, target = { home: join(root, "two") };
        const from = join(current.home, "sessions", "2026", "10", "12", "rollout-session.jsonl");
        const to = join(target.home, "sessions", "2026", "10", "12", "rollout-session.jsonl");
        mkdirSync(join(current.home, "sessions", "2026", "10", "12"), { recursive: true });
        mkdirSync(join(target.home, "sessions", "2026", "10", "12"), { recursive: true });
        writeFileSync(from, original + newer);
        if (kind !== "missing") writeFileSync(to, kind === "divergent" ? "different\n" : original);
        return { root, current, target, from, to };
      }],
      when: ["transferring exact bytes without authentication data", fx => transferCodexSession("/pane", fx.current, fx.target, {
        discover: () => ({ sessionId, path: fx.from }), writers: () => kind === "target-writer" ? [100] : [] })],
      then: ["only absent or verified older copies receive the current session", (result, fx) => {
        expect(readFileSync(fx.from, "utf8")).toBe(original + newer);
        expect(result.ok).toBe(["missing", "older-prefix"].includes(kind));
        expect(readFileSync(fx.to, "utf8")).toBe(kind === "divergent" ? "different\n" : kind === "target-writer" ? original : original + newer);
        expect(existsSync(join(fx.target.home, "auth.json"))).toBe(false);
      }], cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
    });
  }
  integration("a foreign probe copy with the same UUID cannot masquerade as exact continuity", {
    given: ["the target has an old probe rollout for another cwd with the same session id", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-session-duplicate-"));
      const current = { home: join(root, "one") }, target = { home: join(root, "two") };
      mkdirSync(join(current.home, "sessions"), { recursive: true });
      mkdirSync(join(target.home, "sessions"), { recursive: true });
      const from = join(current.home, "sessions", "rollout-current.jsonl");
      const probe = join(target.home, "sessions", "rollout-probe.jsonl");
      writeFileSync(from, original + newer);
      writeFileSync(probe, metadata("/old/probe") + newer);
      return { root, current, target, from, probe };
    }],
    when: ["transferring without deleting either history", fx => transferCodexSession("/pane", fx.current, fx.target, {
      discover: () => ({ sessionId, path: fx.from }), writers: () => [],
    })],
    then: ["continuity is refused so the caller can save a labeled fresh handover", (result, fx) => {
      expect(result.ok).toBe(false);
      expect(result.reason).toContain("ambiguous");
      expect(readFileSync(fx.from, "utf8")).toBe(original + newer);
      expect(readFileSync(fx.probe, "utf8")).toBe(metadata("/old/probe") + newer);
    }],
    cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
});
