import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { formatCatchupPreview, shortenForPreview } from "./catchup-format.mjs";
import { readLastTurns, countTurnsSince } from "./jsonl-reader.mjs";
import { renderCatchupLine } from "../handlers.mjs";

// --- Fixture builders ------------------------------------------------------

const turnWithAssistantText = (ts, userPrompt, assistantText) => ({
  timestamp: ts,
  userPrompt,
  items: [{ type: "text", content: assistantText }],
});

const turnPending = (ts, userPrompt) => ({
  timestamp: ts,
  userPrompt,
  items: [],
});

const turnToolOnly = (ts, userPrompt, toolName = "Bash ls") => ({
  timestamp: ts,
  userPrompt,
  items: [{ type: "tool", content: toolName }],
});

// Fixed afternoon timestamps so the rendered HH:MM is deterministic.
// Note: new Date(ISO) respects local TZ; to avoid env flakiness we pick a
// Z-time that's unlikely to cross day boundaries but verify via regex not
// exact values.
const T1 = "2026-04-22T15:02:00Z";
const T2 = "2026-04-22T15:15:00Z";
const T3 = "2026-04-22T15:30:00Z";
const T4 = "2026-04-22T15:45:00Z";
const T5 = "2026-04-22T16:00:00Z";

// --- 1. Empty input --------------------------------------------------------

feature("formatCatchupPreview: empty input", () => {
  unit("no turns → empty array", {
    when: ["formatting empty", () => formatCatchupPreview([])],
    then: ["returns []", (r) => expect(r).toEqual([])],
  });
});

// --- 2. Single turn --------------------------------------------------------

feature("formatCatchupPreview: single turn", () => {
  unit("1 turn with assistant text → 1 preview line, role=assistant", {
    given: ["one completed turn", () => [turnWithAssistantText(T1, "hi", "hello back")]],
    when: ["formatting", (turns) => formatCatchupPreview(turns)],
    then: ["1 line with 'claw:' prefix + content", (lines) => {
      expect(lines.length).toBe(1);
      expect(lines[0]).toMatch(/^• \d{2}:\d{2} claw: hello back$/);
    }],
  });

  unit("1 pending turn (no assistant yet) → user-side line", {
    given: ["pending turn", () => [turnPending(T1, "kör testen")]],
    when: ["formatting", (turns) => formatCatchupPreview(turns)],
    then: ["shows 'you: kör testen'", (lines) => {
      expect(lines.length).toBe(1);
      expect(lines[0]).toMatch(/^• \d{2}:\d{2} you: kör testen$/);
    }],
  });
});

// --- 3. Three turns chronological -----------------------------------------

feature("formatCatchupPreview: 3 turns chronological", () => {
  unit("3 turns with text → 3 lines in chronological order", {
    given: ["3 chronological turns", () => [
      turnWithAssistantText(T1, "q1", "answer 1"),
      turnWithAssistantText(T2, "q2", "answer 2"),
      turnWithAssistantText(T3, "q3", "answer 3"),
    ]],
    when: ["formatting", (turns) => formatCatchupPreview(turns)],
    then: ["3 lines, answer 1 first, answer 3 last", (lines) => {
      expect(lines.length).toBe(3);
      expect(lines[0]).toContain("answer 1");
      expect(lines[1]).toContain("answer 2");
      expect(lines[2]).toContain("answer 3");
    }],
  });
});

// --- 4. Cap at 3 -----------------------------------------------------------

feature("formatCatchupPreview: cap at 3", () => {
  unit("5 turns → only last 3 shown", {
    given: ["5 turns", () => [
      turnWithAssistantText(T1, "q1", "a1"),
      turnWithAssistantText(T2, "q2", "a2"),
      turnWithAssistantText(T3, "q3", "a3"),
      turnWithAssistantText(T4, "q4", "a4"),
      turnWithAssistantText(T5, "q5", "a5"),
    ]],
    when: ["formatting", (turns) => formatCatchupPreview(turns)],
    then: ["only a3, a4, a5 in output (last 3)", (lines) => {
      expect(lines.length).toBe(3);
      expect(lines[0]).toContain("a3");
      expect(lines[2]).toContain("a5");
      expect(lines.some((l) => l.includes("a1"))).toBe(false);
      expect(lines.some((l) => l.includes("a2"))).toBe(false);
    }],
  });
});

// --- 5. Long text truncation ----------------------------------------------

feature("formatCatchupPreview: long text truncation", () => {
  unit("200-char text → preview trimmed to ~80 + ellipsis", {
    given: ["turn with 200-char assistant response", () => [
      turnWithAssistantText(T1, "q", "a".repeat(200)),
    ]],
    when: ["formatting", (turns) => formatCatchupPreview(turns)],
    then: ["content capped and ends in ellipsis", (lines) => {
      expect(lines[0]).toMatch(/…$/);
      // Total line length should be roughly under 100 (prefix "• HH:MM claw: " is ~14 chars
      // plus ~80 preview chars + "…" = ~95)
      expect(lines[0].length).toBeLessThan(110);
    }],
  });
});

// --- 6. Multi-line → first line + ellipsis --------------------------------

feature("formatCatchupPreview: multi-line text", () => {
  unit("multi-line content → only first line shown, ellipsis appended", {
    given: ["multi-line assistant text", () => [
      turnWithAssistantText(T1, "q", "line one\nline two\nline three"),
    ]],
    when: ["formatting", (turns) => formatCatchupPreview(turns)],
    then: ["first line + ellipsis, no 'line two'", (lines) => {
      expect(lines[0]).toContain("line one");
      expect(lines[0]).not.toContain("line two");
      expect(lines[0]).toMatch(/…$/);
    }],
  });
});

// --- 7. Tool-only turn skipped --------------------------------------------

feature("formatCatchupPreview: tool-only turn skipped", () => {
  unit("tool-only turn is skipped; next readable turn fills the slot", {
    given: ["3 turns: readable, tool-only, readable", () => [
      turnWithAssistantText(T1, "q1", "first answer"),
      turnToolOnly(T2, "q2", "Bash ls"),
      turnWithAssistantText(T3, "q3", "second answer"),
    ]],
    when: ["formatting", (turns) => formatCatchupPreview(turns)],
    then: ["2 preview lines, tool-only gone", (lines) => {
      expect(lines.length).toBe(2);
      expect(lines[0]).toContain("first answer");
      expect(lines[1]).toContain("second answer");
      expect(lines.some((l) => l.includes("Bash ls"))).toBe(false);
      expect(lines.some((l) => l.includes("q2"))).toBe(false);
    }],
  });

  unit("all-tool-only input → empty result", {
    given: ["3 tool-only turns", () => [
      turnToolOnly(T1, "q1"),
      turnToolOnly(T2, "q2"),
      turnToolOnly(T3, "q3"),
    ]],
    when: ["formatting", (turns) => formatCatchupPreview(turns)],
    then: ["no lines", (lines) => expect(lines).toEqual([])],
  });
});

// --- 8. Code block collapse ------------------------------------------------

feature("formatCatchupPreview: code blocks", () => {
  unit("fenced code block replaced with [code]", {
    given: ["turn with code-fenced response", () => [
      turnWithAssistantText(
        T1,
        "show code",
        "Here's the fix:\n```js\nconsole.log('x');\nconsole.log('y');\n```",
      ),
    ]],
    when: ["formatting", (turns) => formatCatchupPreview(turns)],
    then: ["output has first prose line, code fence replaced", (lines) => {
      expect(lines[0]).toContain("Here's the fix:");
      expect(lines[0]).not.toContain("console.log");
      expect(lines[0]).not.toContain("```");
    }],
  });

  unit("content that is only a code fence → first line is [code]", {
    given: ["turn with only code fence", () => [
      turnWithAssistantText(T1, "q", "```py\nx = 1\n```"),
    ]],
    when: ["formatting", (turns) => formatCatchupPreview(turns)],
    then: ["preview contains [code] marker", (lines) => {
      expect(lines[0]).toContain("[code]");
    }],
  });
});

// --- 9 & 10. Role prefixes -------------------------------------------------

feature("formatCatchupPreview: role prefixes", () => {
  unit("user-side row (pending turn) → 'you:' prefix", {
    given: ["pending turn", () => [turnPending(T1, "what now?")]],
    when: ["formatting", (turns) => formatCatchupPreview(turns)],
    then: ["prefix is 'you:'", (lines) => {
      expect(lines[0]).toMatch(/\byou: what now\?$/);
    }],
  });

  unit("assistant-side row → agent-name prefix (default 'claw')", {
    given: ["turn with assistant text", () => [turnWithAssistantText(T1, "q", "ok")]],
    when: ["formatting default", (turns) => formatCatchupPreview(turns)],
    then: ["prefix is 'claw:'", (lines) => {
      expect(lines[0]).toMatch(/\bclaw: ok$/);
    }],
  });

  unit("agentName override → custom prefix", {
    given: ["turn with assistant text", () => [turnWithAssistantText(T1, "q", "ok")]],
    when: ["formatting with agentName='api'", (turns) => formatCatchupPreview(turns, { agentName: "api" })],
    then: ["prefix is 'api:'", (lines) => {
      expect(lines[0]).toMatch(/\bapi: ok$/);
    }],
  });
});

// --- Extra: mixed shape matches the example in spec ------------------------

feature("formatCatchupPreview: spec example shape", () => {
  unit("mix of assistant responses and a pending turn renders role-mixed rows", {
    given: ["2 completed + 1 pending turn", () => [
      turnWithAssistantText(T1, "kör testen igen", "ran the tests"),
      turnWithAssistantText(T2, "show result", "All 560 tests passed"),
      turnPending(T3, "commit och push"),
    ]],
    when: ["formatting", (turns) => formatCatchupPreview(turns)],
    then: ["3 lines with mixed role prefixes", (lines) => {
      expect(lines.length).toBe(3);
      expect(lines[0]).toContain("claw:");
      expect(lines[1]).toContain("claw:");
      expect(lines[2]).toContain("you:");
      expect(lines[2]).toContain("commit och push");
    }],
  });
});

// --- shortenForPreview unit tests (directly) -------------------------------

// --- Integration: full catchup body (count + previews) from real jsonl ----

feature("catchup body: count + previews composition (integration)", () => {
  function setupFakeJsonl(turns) {
    const fakeHome = mkdtempSync(join(tmpdir(), "agentmux-catchup-int-"));
    const origHome = process.env.HOME;
    process.env.HOME = fakeHome;
    const paneDir = "/fake/catchup-int/dir";
    const encoded = paneDir.replace(/[\/\.]/g, "-");
    const projectDir = join(fakeHome, ".claude", "projects", encoded);
    mkdirSync(projectDir, { recursive: true });
    const lines = [];
    for (const t of turns) {
      lines.push(JSON.stringify({
        type: "user",
        timestamp: t.userTs,
        message: { role: "user", content: t.userPrompt },
      }));
      if (t.assistantText) {
        lines.push(JSON.stringify({
          type: "assistant",
          timestamp: t.assistantTs || t.userTs,
          message: {
            role: "assistant",
            content: [{ type: "text", text: t.assistantText }],
            stop_reason: "end_turn",
          },
        }));
      }
    }
    writeFileSync(join(projectDir, "session.jsonl"), lines.join("\n") + "\n");
    return {
      paneDir,
      cleanup: () => {
        process.env.HOME = origHome;
        rmSync(fakeHome, { recursive: true, force: true });
      },
    };
  }

  unit("count-line + 3 previews built from real jsonl + lastTs filter", {
    given: ["fake jsonl with 4 turns after a cutoff", () => {
      const ctx = setupFakeJsonl([
        { userTs: "2026-04-22T13:00:00Z", userPrompt: "old stuff", assistantText: "old reply" },
        { userTs: "2026-04-22T15:02:00Z", userPrompt: "kör testen", assistantText: "tests green" },
        { userTs: "2026-04-22T15:15:00Z", userPrompt: "show result", assistantText: "All 560 passed" },
        { userTs: "2026-04-22T15:30:00Z", userPrompt: "commit och push", assistantText: "pushed main" },
        { userTs: "2026-04-22T15:45:00Z", userPrompt: "skip a deploy step" }, // pending
      ]);
      return { ctx, lastTs: "2026-04-22T14:00:00Z" };
    }],
    when: ["building count-line + previews end-to-end", ({ ctx, lastTs }) => {
      const count = countTurnsSince(ctx.paneDir, lastTs);
      const countLine = renderCatchupLine(count);
      const turnsRes = readLastTurns(ctx.paneDir, { since: new Date(lastTs), limit: 10 });
      const previews = formatCatchupPreview(turnsRes.turns, { agentName: "claw" });
      return { countLine, previews, ctx };
    }],
    then: ["count says 4 turns, previews show last 3 readable rows", ({ countLine, previews, ctx }) => {
      // count = 4 real user-turns after the cutoff ("old stuff" pre-dates)
      expect(countLine).toMatch(/ℹ 4 turns since your last Discord sync/);
      // previews = last 3 of the 4 turns. Turn 2/3 have assistant text,
      // turn 4 is pending (user-side). Tool-only is N/A here.
      expect(previews.length).toBe(3);
      expect(previews.some((l) => l.includes("All 560 passed"))).toBe(true);
      expect(previews.some((l) => l.includes("pushed main"))).toBe(true);
      expect(previews.some((l) => l.includes("you: skip a deploy step"))).toBe(true);
      // "old reply" pre-dated lastTs → must not appear
      expect(previews.some((l) => l.includes("old"))).toBe(false);
      ctx.cleanup();
    }],
  });

  unit("0 new turns since lastTs → count-line is null, no previews posted", {
    given: ["jsonl where everything pre-dates the cutoff", () => {
      const ctx = setupFakeJsonl([
        { userTs: "2026-04-22T10:00:00Z", userPrompt: "q1", assistantText: "a1" },
      ]);
      return { ctx, lastTs: "2026-04-22T15:00:00Z" };
    }],
    when: ["checking", ({ ctx, lastTs }) => {
      const count = countTurnsSince(ctx.paneDir, lastTs);
      return { countLine: renderCatchupLine(count), ctx };
    }],
    then: ["renderCatchupLine returns null → handler skips everything", ({ countLine, ctx }) => {
      expect(countLine).toBeNull();
      ctx.cleanup();
    }],
  });
});

feature("shortenForPreview", () => {
  unit("short text unchanged", {
    when: ["formatting 'hello'", () => shortenForPreview("hello")],
    then: ["returns 'hello'", (s) => expect(s).toBe("hello")],
  });

  unit("trims whitespace around the text", {
    when: ["formatting '  hi  '", () => shortenForPreview("  hi  ")],
    then: ["returns 'hi'", (s) => expect(s).toBe("hi")],
  });

  unit("null/undefined returns empty string", {
    when: ["formatting null", () => shortenForPreview(null)],
    then: ["empty string", (s) => expect(s).toBe("")],
  });
});
