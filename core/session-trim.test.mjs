import { component, expect, feature, unit } from "bdd-vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  formatTrimResult, liveNativeSessionIds, trimCheckpointedSession, trimOversizedSessions,
} from "./session-trim.mjs";

const NOW = Date.parse("2026-07-22T08:00:00Z");
const OLD = new Date(NOW - 60 * 60_000);
const EMPTY_IDS = new Set();
const refreshEmpty = () => new Set();

function fixture(provider, lines) {
  const root = mkdtempSync(join(tmpdir(), "amux-session-trim-"));
  const id = "019f5d43-9b4b-7e42-b8bd-9de61683501b";
  const dir = provider === "claude"
    ? join(root, ".claude", "projects", "-workspace")
    : join(root, ".codex", "sessions", "2026", "07", "22");
  mkdirSync(dir, { recursive: true });
  const name = provider === "claude" ? `${id}.jsonl` : `rollout-now-${id}.jsonl`;
  const path = join(dir, name);
  writeFileSync(path, `${lines.join("\n")}\n`);
  utimesSync(path, OLD, OLD);
  return { root, path, id, before: readFileSync(path, "utf8") };
}

feature("checkpoint-aware provider session trim", () => {
  component("Claude retains its identity header and latest compact root", {
    given: ["a stable inactive Claude journal with discarded pre-compact bytes", () => fixture("claude", [
      JSON.stringify({ type: "permission-mode", permissionMode: "bypassPermissions", sessionId: "019f5d43-9b4b-7e42-b8bd-9de61683501b" }),
      JSON.stringify({ type: "user", message: { content: "discard-me".repeat(200) } }),
      JSON.stringify({ parentUuid: null, type: "system", subtype: "compact_boundary", content: "Conversation compacted" }),
      JSON.stringify({ type: "user", isCompactSummary: true, message: { content: "keep-summary" } }),
      JSON.stringify({ type: "assistant", message: { content: "keep-new" } }),
    ])],
    when: ["trimming from the provider checkpoint", (ctx) => ({
      ...ctx,
      result: trimCheckpointedSession(ctx.path, { nowMs: NOW, liveIds: EMPTY_IDS, refreshLiveIds: refreshEmpty }),
    })],
    then: ["the file shrinks atomically and every retained row is complete JSON", (ctx) => {
      try {
        const after = readFileSync(ctx.path, "utf8");
        expect(ctx.result.status).toBe("trimmed");
        expect(after).toContain("permission-mode");
        expect(after).toContain("compact_boundary");
        expect(after).toContain("keep-summary");
        expect(after).not.toContain("discard-me");
        expect(after.trim().split("\n").every((line) => Boolean(JSON.parse(line)))).toBe(true);
        expect(statSync(ctx.path).size).toBeLessThan(Buffer.byteLength(ctx.before));
      } finally { rmSync(ctx.root, { recursive: true, force: true }); }
    }],
  });

  component("Codex retains session_meta and replacement_history", {
    given: ["a stable inactive Codex rollout after native compaction", () => fixture("codex", [
      JSON.stringify({ timestamp: "t0", type: "session_meta", payload: { id: "019f5d43-9b4b-7e42-b8bd-9de61683501b", cwd: "/work" } }),
      JSON.stringify({ timestamp: "t1", type: "response_item", payload: { text: "discard-me".repeat(200) } }),
      JSON.stringify({ timestamp: "t2", type: "compacted", payload: { message: "", replacement_history: [{ type: "message", content: "keep-summary" }] } }),
      JSON.stringify({ timestamp: "t3", type: "event_msg", payload: { type: "context_compacted" } }),
    ])],
    when: ["trimming from replacement_history", (ctx) => ({
      ...ctx,
      result: trimCheckpointedSession(ctx.path, { nowMs: NOW, liveIds: EMPTY_IDS, refreshLiveIds: refreshEmpty }),
    })],
    then: ["identity and the replacement survive without arbitrary tail cutting", (ctx) => {
      try {
        const after = readFileSync(ctx.path, "utf8");
        expect(ctx.result).toMatchObject({ status: "trimmed", provider: "codex" });
        expect(after).toContain("session_meta");
        expect(after).toContain("replacement_history");
        expect(after).not.toContain("discard-me");
      } finally { rmSync(ctx.root, { recursive: true, force: true }); }
    }],
  });

  unit("active, changing, and not-yet-compacted sessions fail closed", {
    given: ["three unsafe Claude journals", () => ({
      active: fixture("claude", [JSON.stringify({ type: "permission-mode" }), JSON.stringify({ type: "system", subtype: "compact_boundary" })]),
      changing: fixture("claude", [JSON.stringify({ type: "permission-mode" }), JSON.stringify({ type: "system", subtype: "compact_boundary" })]),
      raw: fixture("claude", [JSON.stringify({ type: "permission-mode" }), JSON.stringify({ type: "user", message: { content: "important" } })]),
    })],
    when: ["the safety classifier runs", ({ active, changing, raw }) => {
      utimesSync(changing.path, new Date(NOW - 1000), new Date(NOW - 1000));
      return {
        active, changing, raw,
        results: [
          trimCheckpointedSession(active.path, { nowMs: NOW, liveIds: new Set([active.id]) }),
          trimCheckpointedSession(changing.path, { nowMs: NOW, liveIds: EMPTY_IDS }),
          trimCheckpointedSession(raw.path, { nowMs: NOW, liveIds: EMPTY_IDS }),
        ],
      };
    }],
    then: ["none is mutated and the reasons are exact", ({ active, changing, raw, results }) => {
      try {
        expect(results.map((item) => item.reason)).toEqual(["active-session", "recently-changing", "needs-compact"]);
        expect(readFileSync(active.path, "utf8")).toBe(active.before);
        expect(readFileSync(changing.path, "utf8")).toBe(changing.before);
        expect(readFileSync(raw.path, "utf8")).toBe(raw.before);
      } finally {
        for (const ctx of [active, changing, raw]) rmSync(ctx.root, { recursive: true, force: true });
      }
    }],
  });

  unit("live process discovery fails closed when proc is unavailable", {
    given: ["a missing proc root", () => join(tmpdir(), "missing-amux-proc")],
    when: ["discovering native writers", (procRoot) => liveNativeSessionIds({ procRoot })],
    then: ["unknown is distinct from no live sessions", (ids) => expect(ids).toBeNull()],
  });

  unit("live discovery trusts the provider executable, not incidental prompt text", {
    given: ["a real Claude argv and a shell command that merely mentions Claude", () => {
      const procRoot = mkdtempSync(join(tmpdir(), "amux-proc-"));
      const real = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
      const incidental = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
      mkdirSync(join(procRoot, "100"));
      mkdirSync(join(procRoot, "200"));
      writeFileSync(join(procRoot, "100", "cmdline"), `/bin/bash\0-lc\0echo claude ${incidental}\0`);
      writeFileSync(join(procRoot, "200", "cmdline"), `/usr/local/bin/claude\0--resume\0${real}\0`);
      return { procRoot, real, incidental };
    }],
    when: ["collecting exact live identities", (ctx) => ({ ...ctx, ids: liveNativeSessionIds({ procRoot: ctx.procRoot }) })],
    then: ["only the provider-owned session is fenced", ({ procRoot, real, incidental, ids }) => {
      try {
        expect([...ids]).toEqual([real]);
        expect(ids.has(incidental)).toBe(false);
      } finally { rmSync(procRoot, { recursive: true, force: true }); }
    }],
  });

  unit("batch output distinguishes reclaimed bytes from protected files", {
    given: ["two oversized candidates represented by an injected policy", () => {
      const root = mkdtempSync(join(tmpdir(), "amux-trim-batch-"));
      writeFileSync(join(root, "a.jsonl"), "x".repeat(200));
      writeFileSync(join(root, "b.jsonl"), "y".repeat(200));
      return { root };
    }],
    when: ["running a dry batch", ({ root }) => ({
      root,
      result: trimOversizedSessions({
        roots: [root], thresholdBytes: 100, dryRun: true,
        trimOne: (path) => path.endsWith("a.jsonl")
          ? { path, status: "would-trim", reclaimedBytes: 150 }
          : { path, status: "protected", reason: "needs-compact" },
      }),
    })],
    then: ["the concise receipt is auditable", ({ root, result }) => {
      try {
        expect(result).toMatchObject({ oversized: 2, wouldTrim: 1, protected: 1, reclaimedBytes: 150 });
        expect(formatTrimResult(result)).toContain("needs-compact=1");
      } finally { rmSync(root, { recursive: true, force: true }); }
    }],
  });
});
