import { unit, feature, expect } from "bdd-vitest";
import {
  projectDirFor,
  extractLastUserTurn,
  formatSnippet,
  formatHint,
  stripResumeHint,
  buildResumeHint,
} from "./resume-hint.mjs";

const jsonl = (...events) => events.map((e) => JSON.stringify(e)).join("\n");

/**
 * Build a hint via the production formatter, never a hand-copied string.
 * If the hint's shape ever drifts from what stripResumeHint matches, these
 * tests fail loudly instead of the nesting bug silently returning.
 */
const hintBlock = (snippet, path = "/p/prev.jsonl", ts = "2026-07-01T15:39:18Z") =>
  formatHint(path, { ts, snippet: formatSnippet(snippet) });

feature("projectDirFor — cwd slug", () => {
  unit("slash and dot become dash, prefixed with base dir", {
    given: ["pane dir under .agents/", () => "/home/user/.openclaw/workspace/.agents/0"],
    when: ["resolving", (d) => projectDirFor(d, "/home/user")],
    then: ["matches claude-code slug convention", (p) => {
      expect(p).toBe("/home/user/.claude/projects/-home-user--openclaw-workspace--agents-0");
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
      { type: "user", message: { role: "user", content: [{ type: "text", text: "hej från user" }] }, timestamp: "2026-04-23T12:00:00Z" },
    )],
    when: ["extracting", (j) => extractLastUserTurn(j)],
    then: ["joins the text content", (r) => {
      expect(r.text).toBe("hej från user");
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

feature("formatHint + stripResumeHint — round-trip invariant (anti-drift)", () => {
  unit("anything formatHint emits, stripResumeHint fully consumes", {
    given: ["a hint built by the production formatter", () => formatHint("/p/s.jsonl", {
      ts: "2026-07-09T11:00:00Z",
      snippet: formatSnippet("valfri tidigare fråga"),
    })],
    when: ["stripping it", (h) => stripResumeHint(h)],
    then: ["nothing survives, so it can never be echoed as a user turn", (r) => {
      expect(r).toBe("");
    }],
  });

  unit("invariant holds when the hint carries no timestamp", {
    given: ["hint with ts omitted", () => formatHint("/p/s.jsonl", { ts: null, snippet: "x" })],
    when: ["stripping it", (h) => stripResumeHint(h)],
    then: ["still fully consumed", (r) => { expect(r).toBe(""); }],
  });

  unit("invariant holds for a maximally-clipped snippet", {
    given: ["hint whose snippet hit the 250-char clip", () => formatHint("/p/s.jsonl", {
      ts: "t", snippet: formatSnippet("å".repeat(400)),
    })],
    when: ["stripping it", (h) => stripResumeHint(h)],
    then: ["still fully consumed", (r) => { expect(r).toBe(""); }],
  });
});

feature("stripResumeHint — the hint never quotes itself", () => {
  unit("strips a hint prepended to a real user brief", {
    given: ["hint block followed by the actual brief", () => `${hintBlock("older turn")}\n\nkör testerna tack`],
    when: ["stripping", (t) => stripResumeHint(t)],
    then: ["only the real brief remains", (r) => {
      expect(r).toBe("kör testerna tack");
    }],
  });

  unit("returns empty for a bare hint with no brief after it", {
    given: ["hint block alone (pane respawned with no user brief)", () => hintBlock("older turn")],
    when: ["stripping", (t) => stripResumeHint(t)],
    then: ["nothing real survives", (r) => { expect(r).toBe(""); }],
  });

  unit("unwraps nested hints (hint quoting a hint quoting a hint)", {
    given: ["three levels of hint nesting, real brief at the end", () => {
      const lvl1 = hintBlock("den riktiga frågan");
      const lvl2 = hintBlock(lvl1);
      return `${lvl2}\n${lvl1}\n\nriktig brief`;
    }],
    when: ["stripping", (t) => stripResumeHint(t)],
    then: ["peels every hint layer, keeps the brief", (r) => {
      expect(r).toBe("riktig brief");
    }],
  });

  unit("returns empty when the hint is truncated (no tail line)", {
    given: ["hint head with no terminator line", () => "[amux resume hint]\nPrevious session: /p/x.jsonl"],
    when: ["stripping", (t) => stripResumeHint(t)],
    then: ["empty, so caller walks further back", (r) => { expect(r).toBe(""); }],
  });

  unit("leaves ordinary text untouched", {
    given: ["a normal brief", () => "installera losslesscut åt mig"],
    when: ["stripping", (t) => stripResumeHint(t)],
    then: ["unchanged", (r) => { expect(r).toBe("installera losslesscut åt mig"); }],
  });
});

feature("extractLastUserTurn — resume hints are not user turns", () => {
  unit("skips injected hint turns and finds the last real turn", {
    given: ["real turn, then two bare hint turns (the observed restart loop)", () => jsonl(
      { type: "user", message: { role: "user", content: "installera losslesscut" }, timestamp: "2026-07-06T10:00:00Z" },
      { type: "user", message: { role: "user", content: hintBlock("installera losslesscut") }, timestamp: "2026-07-07T13:35:06Z" },
      { type: "user", message: { role: "user", content: hintBlock(hintBlock("installera losslesscut")) }, timestamp: "2026-07-08T11:01:29Z" },
    )],
    when: ["extracting", (j) => extractLastUserTurn(j)],
    then: ["returns the real turn, not the hint echo", (r) => {
      expect(r).not.toBeNull();
      expect(r.text).toBe("installera losslesscut");
      expect(r.ts).toBe("2026-07-06T10:00:00Z");
    }],
  });

  unit("keeps the brief when a hint was prepended to it", {
    given: ["a turn that is hint + real brief", () => jsonl(
      { type: "user", message: { role: "user", content: `${hintBlock("gammalt")}\n\nvad gör vi nu?` }, timestamp: "2026-07-08T12:00:00Z" },
    )],
    when: ["extracting", (j) => extractLastUserTurn(j)],
    then: ["hint stripped, brief kept, timestamp preserved", (r) => {
      expect(r.text).toBe("vad gör vi nu?");
      expect(r.ts).toBe("2026-07-08T12:00:00Z");
    }],
  });

  unit("returns null when every turn is a bare hint", {
    given: ["jsonl containing only hint echoes", () => jsonl(
      { type: "user", message: { role: "user", content: hintBlock("borta") }, timestamp: "t1" },
      { type: "user", message: { role: "user", content: hintBlock(hintBlock("borta")) }, timestamp: "t2" },
    )],
    when: ["extracting", (j) => extractLastUserTurn(j)],
    then: ["null rather than echoing a hint", (r) => { expect(r).toBeNull(); }],
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
    when: ["formatting via the production formatter", ({ turn, snippet }) =>
      formatHint("/some/path.jsonl", { ts: turn.timestamp, snippet })],
    then: ["contains signature + anchor + guidance", (out) => {
      expect(out).toContain("[amux resume hint]");
      expect(out).toContain("test user turn");
      expect(out).toContain("2026-04-23T12:00:00Z");
      expect(out).toContain("lost state");
    }],
  });
});
