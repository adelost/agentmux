import { describe, expect, it } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { readClaudeScreenQuality } from "../core/claude-statusline.mjs";
import { readDreamOwnerQuality } from "../core/dream-owner.mjs";
import { claudeProjectDir } from "../core/claude-paths.mjs";
import { cmdDream } from "../cli/dream.mjs";

const FOOTER = "  ⬆ /gsd-update │ Fable 5.1 │ 0 █░░░░░░░░░ 10% · thinking: xhigh";
const SCREEN = `old text\n────────────\n❯ \n────────────\n${FOOTER}\n bypass permissions on`;
const ID = randomUUID();

describe("Dream reads idle Claude quality without trusting stale cache", () => {
  it.each([
    [SCREEN, { model: "Fable 5.1", effort: "xhigh" }],
    [SCREEN.replace("Fable 5.1", "claude-opus-5"), { model: "claude-opus-5", effort: "xhigh" }],
    [`${FOOTER}\n❯ `, null],
    [FOOTER, null],
    [SCREEN.replace("thinking: xhigh", ""), null],
    [SCREEN.replace("Fable 5.1", "unknown model"), null],
    [`${SCREEN}\n❯ pasted ${FOOTER}`, null],
  ])("accepts only a complete current footer", (screen, expected) => {
    const quality = readClaudeScreenQuality(screen);
    if (expected) expect(quality).toMatchObject(expected);
    else expect(quality).toBeNull();
  });

  it.each(["changed-id", "changed-path", "missing", "capture-failed"])("rejects %s session evidence", async (failure) => {
    let calls = 0;
    const quality = await readDreamOwnerQuality({ engine: "claude", paneDir: "/exact" }, {
      latestClaudeIdentity: () => {
        calls++;
        if (failure === "missing") return null;
        return { sessionId: calls > 1 && failure === "changed-id" ? "other" : ID,
          path: calls > 1 && failure === "changed-path" ? "/other" : "/exact.jsonl" };
      },
      captureScreen: async () => { if (failure === "capture-failed") throw Error("offline"); return SCREEN; },
    });
    expect(quality).toBeNull();
  });

  for (const variant of ["idle-overnight", "low", "haiku", "missing-effort", "post-compact-low", "different-compact-session"]) {
    it(`${variant}: uses actual pre/post-compact quality and keeps fences`, async () => {
      const home = mkdtempSync(join(tmpdir(), "amux-dream-claude-"));
      const oldHome = process.env.HOME, oldJanitor = process.env.AMUX_JANITOR_ENABLED;
      const bridgePath = join(tmpdir(), `claude-ctx-${ID}.json`);
      // Unique synthetic session: reproduce the two-hour cache expiry without touching live files.
      writeFileSync(bridgePath, JSON.stringify({ session_id: ID, used_pct: 10,
        timestamp: Math.floor(Date.now() / 1000) - 12 * 3600, model: "claude-fable-5-1", effort: "xhigh" }));
      process.env.HOME = home;
      process.env.AMUX_JANITOR_ENABLED = "false";
      const owner = { agent: "claw", pane: 0, engine: "claude", paneDir: join(home, "pane") };
      const project = claudeProjectDir(owner.paneDir, home);
      mkdirSync(project, { recursive: true });
      writeFileSync(join(project, `${ID}.jsonl`), JSON.stringify({ timestamp: "2026-09-05T16:38:11Z",
        type: "assistant", message: { model: "claude-fable-5-1", usage: { input_tokens: 82837 } } }) + "\n");
      const calls = [];
      let reads = 0;
      let result, error;
      try {
        result = await cmdDream({ configPath: "unused", agent: {
          ensureReady: async () => {},
          captureScreen: async (agent, pane) => {
            expect([agent, pane]).toEqual(["claw", 0]);
            reads++;
            if (variant === "low" || (variant === "post-compact-low" && reads > 1)) return SCREEN.replace("xhigh", "low");
            if (variant === "haiku") return SCREEN.replace("Fable 5.1", "Haiku 4.5");
            if (variant === "missing-effort") return SCREEN.replace("thinking: xhigh", "");
            return SCREEN;
          },
        } }, { workspace: home, quiet: true }, {
          now: new Date("2026-09-06T02:00:00Z"), agents: [], runtimeConfig: {}, owner,
          readReceipts: () => ({ schemaVersion: 1, panes: {} }),
          collectSources: () => ({ sources: [{ agent: "ai", pane: 4, engine: "codex", turns: 1,
            activityCursor: "2026-09-05T22:00:00Z", latestMs: Date.parse("2026-09-05T22:00:00Z"),
            filesOmitted: 0, entries: [{ timestamp: "2026-09-05T22:00:00Z", userPrompt: "Ship fix",
              items: [{ type: "text", content: "Merged; publication blocked." }] }],
          }], unreadable: [], skipped: [] }),
          getStatus: async () => "idle",
          compactClaude: async () => { calls.push("compact"); return { ok: true, compactBoundary: true,
            sessionId: variant === "different-compact-session" ? "other" : ID }; },
          mirrorPrompt: async () => { calls.push("mirror"); return { channelId: "visible", messages: 1 }; },
          send: async () => { calls.push("send"); return { delivered: true }; },
          waitForResult: async () => ({ ok: true, content: "- Merged fix; publication still blocked." }),
          recordReceipts: () => { calls.push("receipt"); },
        });
      } catch (caught) { error = caught; }
      finally {
        if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
        if (oldJanitor === undefined) delete process.env.AMUX_JANITOR_ENABLED; else process.env.AMUX_JANITOR_ENABLED = oldJanitor;
      }
      try {
        if (variant === "idle-overnight") {
          expect(error).toBeUndefined();
          expect(result.owner).toEqual(owner);
          expect(reads).toBe(2);
          expect(calls).toEqual(["compact", "mirror", "send", "receipt"]);
          expect(readFileSync(result.input.path, "utf8")).toContain("claude-live-statusline");
        } else {
          expect(error?.message).toMatch(/dream-owner-quality-(blocked|unverified|session-mismatch)/u);
          expect(calls).not.toContain("send");
          expect(calls).not.toContain("receipt");
          if (!["post-compact-low", "different-compact-session"].includes(variant)) expect(calls).not.toContain("compact");
        }
      } finally {
        rmSync(bridgePath, { force: true });
        rmSync(home, { recursive: true, force: true });
      }
    });
  }
});
