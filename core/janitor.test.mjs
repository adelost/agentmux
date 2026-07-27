import { component, expect, feature, unit } from "bdd-vitest";
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JSONL_TRIM_MARKER, trimJsonlBuffer } from "./jsonl-field-trim.mjs";
import { defaultSessionRoots, formatJanitorResult, trimAgedSessions } from "./janitor.mjs";

const DAY = 24 * 3600 * 1000;
const NOW = Date.parse("2026-05-30T00:00:00Z");

function jsonl(rows) {
  return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

function makeRoot(specs) {
  const root = mkdtempSync(join(tmpdir(), "amux-janitor-"));
  const paths = {};
  for (const [name, ageDays, content] of specs) {
    const path = join(root, name);
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, content);
    const time = new Date(NOW - ageDays * DAY);
    utimesSync(path, time, time);
    paths[name] = path;
  }
  return { root, nowMs: NOW, paths };
}

function largeRows() {
  return [
    { id: "first", message: "searchable-conversation-needle" },
    {
      id: "large",
      message: {
        content: `head-kept ${"åäö-data ".repeat(2_000)} tail-kept`,
      },
    },
    { id: "last", message: "terminal outcome" },
  ];
}

feature("trimJsonlBuffer", () => {
  unit("keeps record order and marks shortened UTF-8 fields", {
    given: ["three records with one oversized field", () => Buffer.from(jsonl(largeRows()))],
    when: ["trimming to a small test line budget", (source) =>
      trimJsonlBuffer(source, { maxLineBytes: 1_024 })],
    then: ["every record remains valid, ordered, searchable, and explicit", (result) => {
      const rows = result.buffer.toString("utf8").trimEnd().split("\n").map(JSON.parse);
      expect(rows.map((row) => row.id)).toEqual(["first", "large", "last"]);
      expect(rows[0].message).toBe("searchable-conversation-needle");
      expect(rows[1].message.content).toContain("head-kept");
      expect(rows[1].message.content).toContain("tail-kept");
      expect(rows[1].message.content).toContain(JSONL_TRIM_MARKER);
      expect(rows[1].message.content).toMatch(/originalBytes=\d+/u);
      expect(result).toMatchObject({ records: 3, trimmedLines: 1, trimmedFields: 1 });
      expect(result.reclaimedBytes).toBeGreaterThan(0);
    }],
  });

  unit("refuses an oversized malformed row instead of dropping it", {
    given: ["one malformed oversized record", () =>
      Buffer.from(`{"id":"ok"}\n{"broken":"${"x".repeat(4_000)}"\n`)],
    when: ["attempting trim", (source) => () =>
      trimJsonlBuffer(source, { maxLineBytes: 1_024 })],
    then: ["the exact line is reported", (run) => {
      expect(run).toThrow(/line-2:invalid-jsonl-line/u);
    }],
  });

  unit("trims tool payloads before ordinary conversation text", {
    given: ["one mixed assistant row with prose and a much larger tool result", () => {
      const prose = `human-visible-answer ${"important dialogue ".repeat(700)}`;
      return {
        prose,
        source: Buffer.from(jsonl([{
          type: "assistant",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: prose },
              { type: "tool_result", content: `tool-head ${"raw-output ".repeat(8_000)} tool-tail` },
            ],
          },
        }])),
      };
    }],
    when: ["trimming the mixed row", ({ prose, source }) => ({
      prose,
      result: trimJsonlBuffer(source, { maxLineBytes: 24 * 1_024 }),
    })],
    then: ["the dialogue is byte-identical while the tool payload is marked", ({ prose, result }) => {
      const [row] = result.buffer.toString("utf8").trimEnd().split("\n").map(JSON.parse);
      expect(row.message.content[0].text).toBe(prose);
      expect(row.message.content[1].content).toContain(`${JSONL_TRIM_MARKER} kind=tool`);
      expect(row.message.content[1].content).toContain("tool-head");
      expect(row.message.content[1].content).toContain("tool-tail");
    }],
  });

  unit("still bounds a conversation-only wall of text as a last resort", {
    given: ["one oversized user paste without tool data", () => Buffer.from(jsonl([{
      type: "user",
      message: { role: "user", content: `question ${"pasted-file ".repeat(8_000)} conclusion` },
    }]))],
    when: ["trimming the conversation-only row", (source) =>
      trimJsonlBuffer(source, { maxLineBytes: 8 * 1_024 })],
    then: ["the row remains searchable and explicitly shortened", (result) => {
      const [row] = result.buffer.toString("utf8").trimEnd().split("\n").map(JSON.parse);
      expect(row.message.content).toContain("question");
      expect(row.message.content).toContain("conclusion");
      expect(row.message.content).toContain(`${JSONL_TRIM_MARKER} kind=conversation`);
    }],
  });

  unit("recognizes Codex response-item tool output without clipping its assistant reply", {
    given: ["Codex-style tool output followed by a normal assistant message", () => {
      const reply = `short answer ${"worth keeping ".repeat(200)}`;
      return {
        reply,
        source: Buffer.from(jsonl([
          {
            type: "response_item",
            payload: {
              type: "function_call_output",
              output: `command output ${"diagnostic bytes ".repeat(8_000)}`,
            },
          },
          {
            type: "response_item",
            payload: {
              type: "message",
              role: "assistant",
              content: [{ type: "output_text", text: reply }],
            },
          },
        ])),
      };
    }],
    when: ["trimming the provider journal", ({ reply, source }) => ({
      reply,
      result: trimJsonlBuffer(source, { maxLineBytes: 8 * 1_024 }),
    })],
    then: ["only the tool row is shortened", ({ reply, result }) => {
      const rows = result.buffer.toString("utf8").trimEnd().split("\n").map(JSON.parse);
      expect(rows[0].payload.output).toContain(`${JSONL_TRIM_MARKER} kind=tool`);
      expect(rows[1].payload.content[0].text).toBe(reply);
    }],
  });
});

feature("trimAgedSessions", () => {
  unit("covers Claude, Codex, and Kimi session roots", {
    given: ["an isolated home", () => "/tmp/amux-home"],
    when: ["resolving defaults", (home) => defaultSessionRoots(home)],
    then: ["all provider journals are included", (roots) => {
      expect(roots).toEqual([
        "/tmp/amux-home/.claude/projects",
        "/tmp/amux-home/.codex/sessions",
        "/tmp/amux-home/.kimi-code/sessions",
      ]);
    }],
  });

  component("atomically trims only aged journals and keeps every record", {
    given: ["one aged oversized journal and one recent byte-identical journal", () => {
      const content = jsonl(largeRows());
      const context = makeRoot([
        ["old.jsonl", 20, content],
        ["live.jsonl", 2, content],
      ]);
      return {
        ...context,
        original: Buffer.from(content),
        oldMtime: statSync(context.paths["old.jsonl"]).mtimeMs,
        liveMtime: statSync(context.paths["live.jsonl"]).mtimeMs,
      };
    }],
    when: ["running aged housekeeping", (context) => ({
      ...context,
      result: trimAgedSessions({
        roots: [context.root],
        retentionDays: 14,
        maxLineBytes: 1_024,
        nowMs: context.nowMs,
      }),
    })],
    then: ["the old file is valid and smaller while the recent file is untouched", (context) => {
      try {
        const old = readFileSync(context.paths["old.jsonl"]);
        const rows = old.toString("utf8").trimEnd().split("\n").map(JSON.parse);
        expect(context.result).toMatchObject({
          scanned: 2, candidates: 1, trimmed: 1, unchanged: 0, failed: 0,
        });
        expect(existsSync(context.paths["old.jsonl"])).toBe(true);
        expect(rows.map((row) => row.id)).toEqual(["first", "large", "last"]);
        expect(rows[0].message).toBe("searchable-conversation-needle");
        expect(old.length).toBeLessThan(context.original.length);
        expect(statSync(context.paths["old.jsonl"]).mtimeMs).toBe(context.oldMtime);
        expect(readFileSync(context.paths["live.jsonl"])).toEqual(context.original);
        expect(statSync(context.paths["live.jsonl"]).mtimeMs).toBe(context.liveMtime);

        const manifest = readFileSync(join(context.root, ".janitor-deleted.log"), "utf8");
        expect(manifest).toContain("\ttrim\t");
        expect(manifest).toContain(context.paths["old.jsonl"]);
        const audit = readFileSync(join(context.root, ".janitor-deleted.log.audit"), "utf8")
          .trim().split("\n").map(JSON.parse);
        expect(audit.map((row) => row.phase)).toEqual(["intent", "completed"]);
        expect(audit.every((row) => row.operation === "replace")).toBe(true);
        expect(audit[1].reclaimedBytes).toBeGreaterThan(0);
      } finally { rmSync(context.root, { recursive: true, force: true }); }
    }],
  });

  component("an audit-intent failure leaves the original file byte-for-byte intact", {
    given: ["an aged journal and an invalid audit destination", () => {
      const context = makeRoot([["old.jsonl", 30, jsonl(largeRows())]]);
      const blocker = join(context.root, "not-a-directory");
      writeFileSync(blocker, "file");
      return {
        ...context,
        before: readFileSync(context.paths["old.jsonl"]),
        auditPath: join(blocker, "audit.jsonl"),
      };
    }],
    when: ["the pre-rename audit cannot be written", (context) => ({
      ...context,
      result: trimAgedSessions({
        roots: [context.root],
        nowMs: context.nowMs,
        maxLineBytes: 1_024,
        auditPath: context.auditPath,
      }),
    })],
    then: ["the operation fails closed without replacing the journal", (context) => {
      try {
        expect(context.result).toMatchObject({ trimmed: 0, failed: 1 });
        expect(readFileSync(context.paths["old.jsonl"])).toEqual(context.before);
      } finally { rmSync(context.root, { recursive: true, force: true }); }
    }],
  });

  unit("dry-run computes reclaim without changing the candidate", {
    given: ["one aged oversized journal", () => {
      const context = makeRoot([["old.jsonl", 30, jsonl(largeRows())]]);
      return { ...context, before: readFileSync(context.paths["old.jsonl"]) };
    }],
    when: ["running a dry trim", (context) => ({
      ...context,
      result: trimAgedSessions({
        roots: [context.root],
        nowMs: context.nowMs,
        maxLineBytes: 1_024,
        dryRun: true,
      }),
    })],
    then: ["reclaim is reported but bytes are unchanged", (context) => {
      try {
        expect(context.result).toMatchObject({ candidates: 1, trimmed: 0, unchanged: 0 });
        expect(context.result.reclaimedBytes).toBeGreaterThan(0);
        expect(readFileSync(context.paths["old.jsonl"])).toEqual(context.before);
      } finally { rmSync(context.root, { recursive: true, force: true }); }
    }],
  });

  unit("reports already-bounded aged journals without rewriting them", {
    given: ["one old small journal", () => {
      const context = makeRoot([["small.jsonl", 40, jsonl([{ id: "kept" }])]]);
      return { ...context, before: readFileSync(context.paths["small.jsonl"]) };
    }],
    when: ["running housekeeping", (context) => ({
      ...context,
      result: trimAgedSessions({ roots: [context.root], nowMs: context.nowMs }),
    })],
    then: ["the journal remains byte-identical", (context) => {
      try {
        expect(context.result).toMatchObject({ candidates: 1, trimmed: 0, unchanged: 1 });
        expect(readFileSync(context.paths["small.jsonl"])).toEqual(context.before);
      } finally { rmSync(context.root, { recursive: true, force: true }); }
    }],
  });

  unit("recurses nested session directories and ignores non-jsonl files", {
    given: ["one nested old journal plus similarly named files", () => makeRoot([
      ["2026/01/15/rollout.jsonl", 60, jsonl([{ id: "kept" }])],
      ["notes.md", 60, "notes"],
      ["rollout.jsonl.bak", 60, "backup"],
    ])],
    when: ["scanning", (context) => ({
      ...context,
      result: trimAgedSessions({ roots: [context.root], nowMs: context.nowMs }),
    })],
    then: ["only the JSONL record is considered", (context) => {
      try {
        expect(context.result).toMatchObject({ scanned: 1, candidates: 1, unchanged: 1 });
      } finally { rmSync(context.root, { recursive: true, force: true }); }
    }],
  });
});

feature("formatJanitorResult", () => {
  unit("reports bounded aged files without claiming deletion", {
    given: ["a completed result", () => ({
      scanned: 10, candidates: 4, trimmed: 3, unchanged: 1, failed: 0,
      reclaimedBytes: 5 * 1024 * 1024, retentionDays: 14, dryRun: false,
    })],
    when: ["formatting", (result) => formatJanitorResult(result)],
    then: ["the receipt names trim and reclaimed bytes", (text) => {
      expect(text).toContain("trimmed 3/4");
      expect(text).toContain("reclaimed 5.0MB");
      expect(text).not.toContain("deleted");
    }],
  });

  unit("separates recent oversized journals from aged trim", {
    given: ["one recent oversized journal", () => ({
      scanned: 1, candidates: 0, trimmed: 0, unchanged: 0, failed: 0,
      reclaimedBytes: 0, retentionDays: 14, dryRun: false,
      oversized: 1, oversizedBytes: 70 * 1024 * 1024,
    })],
    when: ["formatting", (result) => formatJanitorResult(result)],
    then: ["the recent file is explicitly untouched", (text) => {
      expect(text).toContain("1 recent oversized");
      expect(text).toContain("untouched by aged trim");
    }],
  });
});
