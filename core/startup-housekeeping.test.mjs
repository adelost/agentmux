import { component, expect, feature, unit } from "bdd-vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatStartupHousekeeping,
  rotateClosedLog,
  runStartupHousekeeping,
} from "./startup-housekeeping.mjs";

const DAY = 24 * 60 * 60 * 1000;

feature("startup storage housekeeping", () => {
  unit("atomically retains only complete records from a closed oversized log", {
    given: ["a closed AMUX log above its cap", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-startup-log-"));
      const path = join(root, "bridge.log");
      writeFileSync(path, Array.from({ length: 20 }, (_, index) => `record-${String(index).padStart(2, "0")} payload\n`).join(""));
      return { root, path };
    }],
    when: ["rotating its bounded tail", ({ root, path }) => ({
      root, path, result: rotateClosedLog(path, { maxBytes: 100, keepBytes: 80 }),
    })],
    then: ["the newest complete records survive under the keep bound", ({ root, path, result }) => {
      try {
        const content = readFileSync(path, "utf8");
        expect(result.rotated).toBe(true);
        expect(statSync(path).size).toBeLessThanOrEqual(80);
        expect(content).toContain("record-19");
        expect(content).not.toContain("record-00");
        expect(content.startsWith("record-")).toBe(true);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }],
  });

  component("prunes old sessions but reports and preserves recent large state", {
    given: ["an old journal, a recent large journal, and an oversized bridge log", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-startup-storage-"));
      const sessions = join(root, "sessions");
      mkdirSync(sessions, { recursive: true });
      const oldPath = join(sessions, "old.jsonl");
      const livePath = join(sessions, "live.jsonl");
      const logPath = join(root, "bridge.log");
      writeFileSync(oldPath, "old\n".repeat(20));
      writeFileSync(livePath, "resumable\n".repeat(40));
      writeFileSync(logPath, "bridge output\n".repeat(30));
      const nowMs = Date.parse("2026-07-21T12:00:00Z");
      const old = new Date(nowMs - 20 * DAY);
      const recent = new Date(nowMs - DAY);
      utimesSync(oldPath, old, old);
      utimesSync(livePath, recent, recent);
      return { root, sessions, oldPath, livePath, logPath, nowMs };
    }],
    when: ["running startup housekeeping", (ctx) => ({
      ...ctx,
      result: runStartupHousekeeping({
        env: {
          HOME: ctx.root,
          AMUX_BRIDGE_LOG_MAX_BYTES: "100",
          AMUX_BRIDGE_LOG_KEEP_BYTES: "60",
          AMUX_JANITOR_OVERSIZED_BYTES: "100",
        },
        bridgeLogPath: ctx.logPath,
        roots: [ctx.sessions],
        nowMs: ctx.nowMs,
      }),
    })],
    then: ["old state is archived while recent resumable state is untouched", (ctx) => {
      try {
        expect(ctx.result.log.rotated).toBe(true);
        expect(ctx.result.sessions.deleted).toBe(1);
        expect(ctx.result.sessions.oversized).toBe(1);
        expect(readFileSync(ctx.livePath, "utf8")).toContain("resumable");
        expect(formatStartupHousekeeping(ctx.result)).toContain("not age-deleted");
        expect(formatStartupHousekeeping(ctx.result)).toContain("trim:");
      } finally {
        rmSync(ctx.root, { recursive: true, force: true });
      }
    }],
  });

  component("trims a stable young provider journal only from its compact checkpoint", {
    given: ["a young oversized compacted Claude journal", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-startup-checkpoint-"));
      const sessions = join(root, ".claude", "projects", "-work");
      mkdirSync(sessions, { recursive: true });
      const id = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      const path = join(sessions, `${id}.jsonl`);
      writeFileSync(path, [
        JSON.stringify({ type: "permission-mode", sessionId: id }),
        JSON.stringify({ type: "user", message: { content: "old".repeat(100) } }),
        JSON.stringify({ parentUuid: null, type: "system", subtype: "compact_boundary" }),
        JSON.stringify({ type: "user", isCompactSummary: true, message: { content: "summary" } }),
      ].join("\n") + "\n");
      const nowMs = Date.parse("2026-07-22T12:00:00Z");
      const stable = new Date(nowMs - 60 * 60_000);
      utimesSync(path, stable, stable);
      return { root, path, nowMs, before: statSync(path).size };
    }],
    when: ["startup housekeeping applies the shared safe policy", (ctx) => ({
      ...ctx,
      result: runStartupHousekeeping({
        env: { HOME: ctx.root, AMUX_JANITOR_OVERSIZED_BYTES: "100" },
        bridgeLogPath: join(ctx.root, "bridge.log"),
        roots: [join(ctx.root, ".claude", "projects")],
        nowMs: ctx.nowMs,
      }),
    })],
    then: ["only pre-checkpoint bytes are reclaimed", (ctx) => {
      try {
        const content = readFileSync(ctx.path, "utf8");
        expect(ctx.result.trim.trimmed).toBe(1);
        expect(statSync(ctx.path).size).toBeLessThan(ctx.before);
        expect(content).toContain("compact_boundary");
        expect(content).not.toContain("oldoldold");
      } finally { rmSync(ctx.root, { recursive: true, force: true }); }
    }],
  });
});
