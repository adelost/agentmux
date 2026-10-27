import { feature, integration, unit, expect } from "bdd-vitest";
import { freshCodexAccount, prepareCodexAccountHandover } from "./codex-account-handover.mjs";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
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
  unit("a pane showing GPT-6.1 Terra xhigh passes the model check", {
    when: ["recovering a Terra pane that has just started a turn", () => freshCodexAccount({ name: "claw", pane: 5, handover: { ok: true },
      agent: { captureScreen: async () => TERRA_SCREEN, isBusy: async () => true } })],
    then: ["only the busy check stops it", (result) => {
      expect(result).toEqual({ kind: "failed", error: "pane started working before fresh account recovery" });
    }],
  });
});
