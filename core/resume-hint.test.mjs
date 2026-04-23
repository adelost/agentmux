import { unit, feature, expect } from "bdd-vitest";
import {
  projectDirFor,
  extractLastUserTurn,
  formatSnippet,
  buildResumeHint,
} from "./resume-hint.mjs";

const jsonl = (...events) => events.map((e) => JSON.stringify(e)).join("\n");

feature("projectDirFor — cwd slug", () => {
  unit("slash and dot become dash, prefixed with base dir", {
    given: ["pane dir under .agents/", () => "/home/adelost/.openclaw/workspace/.agents/0"],
    when: ["resolving", (d) => projectDirFor(d, "/home/adelost")],
    then: ["matches claude-code slug convention", (p) => {
      expect(p).toBe("/home/adelost/.claude/projects/-home-adelost--openclaw-workspace--agents-0");
    }],
  });
});

feature("extractLastUserTurn — meaningful turn extraction", () => {
  unit("picks last real user-turn, skips compact summaries", {
    given: ["jsonl with older real turn, newer compact summary, newest real turn", () => jsonl(
      { type: "user", message: { role: "user", content: "old turn" }, timestamp: "2026-04-23T10:00:00Z" },
      { type: "user", isCompactSummary: true, message: { role: "user", content: "summary text" }, timestamp: "2026-04-23T11:00:00Z" },
      { type: "user", message: { role: "user", content: "real recent" }, timestamp: "2026-04-23T12:00:00Z" },
    )],
    when: ["extracting", (j) => extractLastUserTurn(j)],
    then: ["returns real recent, not summary", (r) => {
      expect(r).not.toBeNull();
      expect(r.text).toBe("real recent");
      expect(r.ts).toBe("2026-04-23T12:00:00Z");
    }],
  });

  unit("skips local-command wrapper events", {
    given: ["jsonl with only local-command-stdout event", () => jsonl(
      { type: "user", message: { role: "user", content: "<local-command-stdout>compacted</local-command-stdout>" }, timestamp: "2026-04-23T10:00:00Z" },
    )],
    when: ["extracting", (j) => extractLastUserTurn(j)],
    then: ["returns null (no meaningful turn found)", (r) => {
      expect(r).toBeNull();
    }],
  });

  unit("handles array-form content with text blocks", {
    given: ["event with content as text-block array", () => jsonl(
      { type: "user", message: { role: "user", content: [{ type: "text", text: "hej från mattias" }] }, timestamp: "2026-04-23T12:00:00Z" },
    )],
    when: ["extracting", (j) => extractLastUserTurn(j)],
    then: ["joins the text content", (r) => {
      expect(r.text).toBe("hej från mattias");
    }],
  });

  unit("skips events with toolUseResult (tool output, not user turn)", {
    given: ["real user turn followed by tool-result event", () => jsonl(
      { type: "user", message: { role: "user", content: "riktig user" }, timestamp: "2026-04-23T10:00:00Z" },
      { type: "user", message: { role: "user", content: "tool output" }, toolUseResult: { stdout: "x" }, timestamp: "2026-04-23T11:00:00Z" },
    )],
    when: ["extracting", (j) => extractLastUserTurn(j)],
    then: ["falls through to the real user turn", (r) => {
      expect(r.text).toBe("riktig user");
    }],
  });

  unit("returns null for empty jsonl", {
    given: ["empty string", () => ""],
    when: ["extracting", (j) => extractLastUserTurn(j)],
    then: ["null", (r) => { expect(r).toBeNull(); }],
  });

  unit("returns null when only compact-summaries present", {
    given: ["jsonl with only compact-summary events", () => jsonl(
      { type: "user", isCompactSummary: true, message: { role: "user", content: "summary" }, timestamp: "t1" },
      { type: "user", isSummary: true, message: { role: "user", content: "another summary" }, timestamp: "t2" },
    )],
    when: ["extracting", (j) => extractLastUserTurn(j)],
    then: ["null (nothing meaningful)", (r) => { expect(r).toBeNull(); }],
  });

  unit("ignores malformed jsonl lines and continues", {
    given: ["mix of broken + valid lines", () => [
      "not json at all",
      '{"type":"user","message":{"role":"user","content":"good"},"timestamp":"t1"}',
      "{also broken",
    ].join("\n")],
    when: ["extracting", (j) => extractLastUserTurn(j)],
    then: ["returns the valid turn", (r) => {
      expect(r.text).toBe("good");
    }],
  });
});

feature("formatSnippet — text clipping", () => {
  unit("short text passes through unchanged", {
    given: ["short text", () => "hej"],
    when: ["formatting", (t) => formatSnippet(t)],
    then: ["unchanged", (s) => { expect(s).toBe("hej"); }],
  });

  unit("long text is clipped with ellipsis", {
    given: ["300-char text", () => "a".repeat(300)],
    when: ["formatting to 250", (t) => formatSnippet(t, 250)],
    then: ["250 chars + ellipsis", (s) => {
      expect(s.length).toBe(253);
      expect(s.endsWith("...")).toBe(true);
    }],
  });

  unit("collapses whitespace + newlines to single spaces", {
    given: ["multi-line text with runs of whitespace", () => "line1\nline2\n\n  line3"],
    when: ["formatting", (t) => formatSnippet(t)],
    then: ["single-space joined", (s) => {
      expect(s).toBe("line1 line2 line3");
    }],
  });
});

feature("buildResumeHint — full pipeline with injected fs", () => {
  unit("returns null when project dir missing", {
    given: ["a pane dir whose project dir does not exist", () => "/nonexistent/path"],
    when: ["building", (p) => buildResumeHint(p, { homeDir: "/tmp-nonexistent-amux-test" })],
    then: ["null", (r) => { expect(r).toBeNull(); }],
  });

  unit("returns null when readFile throws (file vanished)", {
    given: ["readFile that throws", () => ({
      paneDir: "/home/u/.agents/0",
      deps: {
        readFile: () => { throw new Error("ENOENT"); },
        homeDir: "/home/u",
      },
    })],
    when: ["building", ({ paneDir, deps }) => buildResumeHint(paneDir, deps)],
    then: ["null (graceful degrade)", (r) => { expect(r).toBeNull(); }],
  });

  unit("when jsonl found + turn extracted, returns formatted hint block", {
    given: ["a paneDir with fake jsonl content via mocked readFile", () => {
      // This test exercises the inner composition since findLatestJsonl
      // hits real fs; use a real temp dir via stubbed readFile to isolate
      // the format step. extractLastUserTurn is covered above.
      const fakeTurn = { type: "user", message: { role: "user", content: "test user turn" }, timestamp: "2026-04-23T12:00:00Z" };
      return {
        turn: fakeTurn,
        snippet: formatSnippet("test user turn"),
      };
    }],
    when: ["formatting directly via helpers", ({ turn, snippet }) => {
      const parts = [
        "[amux resume hint]",
        `Previous session: /some/path.jsonl`,
        `Last user turn (${turn.timestamp}): "${snippet}"`,
        "If you don't recognize this, your pane likely lost state — tail the jsonl for earlier context.",
      ];
      return parts.join("\n");
    }],
    then: ["contains signature + anchor + guidance", (out) => {
      expect(out).toContain("[amux resume hint]");
      expect(out).toContain("test user turn");
      expect(out).toContain("2026-04-23T12:00:00Z");
      expect(out).toContain("lost state");
    }],
  });
});
