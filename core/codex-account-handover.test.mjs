import { feature, integration, unit, expect } from "bdd-vitest";
import { freshCodexAccount, prepareCodexAccountHandover } from "./codex-account-handover.mjs";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

const TERRA_SCREEN = readFileSync(new URL("../test/fixtures/codex-0.164-terra-status.txt", import.meta.url), "utf-8");

feature("fresh-account handover preserves exact task text and operational receipts", () => {
  integration("the four-part prompt links a private, exact snapshot", {
    given: ["åäö, an existing drift step and a subsequent machine notification", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-account-handover-"));
      return { root, ask: { id: "ask1", agent: "claw", pane: 5, ts: "2026-10-12T08:00:00Z", verbatim: "Fortsätt med återhämtningen, men läs kvittot före flytten." },
        reply: { agent: "claw", pane: 5, kind: "reply", status: "sent", ts: "2026-10-12T08:01:00Z", text: "Flytten är klar. Kvitto: /private/receipt.json." } };
    }],
    when: ["building the fresh-session handover from the real row contract", fx => prepareCodexAccountHandover({ name: "claw", pane: 5,
      current: { id: "1" }, target: { id: "2" }, dir: "/worktree", refusal: { id: "refusal1" } },
      { root: fx.root, read: () => ({ asks: [fx.ask, { ...fx.ask, id: "machine", verbatim: "<task-notification>done</task-notification>" }], posts: [fx.reply] }) })],
    then: ["no original prompt is blindly replayed, exact evidence and the four guards survive", (result, fx) => {
      const saved = JSON.parse(readFileSync(result.path, "utf8"));
      expect(saved.ask).toEqual(fx.ask); expect(saved.reply).toEqual(fx.reply);
      expect(result.text.split("\n\n")).toHaveLength(4);
      expect(result.text).toContain("Det här är en ny session"); expect(result.text).toContain("Gör aldrig om ett driftsteg");
      expect(statSync(result.path).mode & 0o777).toBe(0o600);
    }], cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
});

feature("fresh account recovery accepts the fleet model", () => {
  integration("a high-effort pane recovers with a verified fresh session", {
    given: ["a separate target account with an exact fresh journal", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-fresh-account-"));
      const sessions = join(root, "sessions"), id = "019f5d43-9b4b-7e42-b8bd-9de61683501b";
      mkdirSync(sessions, { recursive: true });
      writeFileSync(join(sessions, "rollout-2026-11-15T12-00-00-test.jsonl"), JSON.stringify({ type: "session_meta", payload: { id, cwd: "/pane", source: "cli", originator: "codex-tui" } }) + "\n");
      const data = {}, calls = [];
      return { root, id, calls, state: { get: (key, fallback) => data[key] ?? fallback, set: (key, value) => { data[key] = value; } } };
    }],
    when: ["recovering the pane on the target account", async fx => freshCodexAccount({ name: "claw", pane: 5, dir: "/pane",
      state: fx.state, target: { id: "2", home: fx.root }, handover: { ok: true, text: "handover", path: "/handover" },
      agent: { captureScreen: async () => TERRA_SCREEN.replaceAll("xhigh", "high"), isBusy: async () => false,
        restartCodex: async (_name, _pane, launch) => { fx.calls.push(launch); } },
      statusDriver: async () => ({ ok: true, status: { session: fx.id, model: { id: "gpt-6.1-terra", effort: "high" } } }) })],
    then: ["the target identity and high effort verify", (result, fx) => {
      expect(result).toMatchObject({ kind: "switched", fresh: true });
      expect(fx.calls[0]).toMatchObject({ model: "gpt-6.1-terra", effort: "high", newSession: true });
    }], cleanup: fx => rmSync(fx.root, { recursive: true, force: true }),
  });
  unit("a pane showing GPT-6.1 Terra high passes the model check", {
    when: ["recovering a Terra pane that has just started a turn", () => freshCodexAccount({ name: "claw", pane: 5, handover: { ok: true },
      agent: { captureScreen: async () => TERRA_SCREEN.replaceAll("xhigh", "high"), isBusy: async () => true } })],
    then: ["only the busy check stops it", (result) => {
      expect(result).toEqual({ kind: "failed", error: "pane started working before fresh account recovery" });
    }],
  });
});
