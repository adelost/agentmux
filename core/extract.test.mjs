import { unit, feature, expect } from "bdd-vitest";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { extractText, classifyLines, extractSegments, extractMixedStream, isToolLine, isTextBullet } from "./extract.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const fixture = (name) => readFileSync(join(__dir, "../test/fixtures", name), "utf-8");

// --- Classification ---

feature("isToolLine", () => {
  unit("matches Bash tool call", {
    when: ["checking ● Bash(...)", () => isToolLine("● Bash(npm test)")],
    then: ["is tool", (r) => expect(r).toBe(true)],
  });

  unit("matches Read summary", {
    when: ["checking ● Read 1 file", () => isToolLine("● Read 1 file (ctrl+o to expand)")],
    then: ["is tool", (r) => expect(r).toBe(true)],
  });

  unit("matches Searched summary", {
    when: ["checking ● Searched for 2 patterns", () => isToolLine("● Searched for 2 patterns (ctrl+o to expand)")],
    then: ["is tool", (r) => expect(r).toBe(true)],
  });

  unit("matches Edit tool call", {
    when: ["checking ● Edit(...)", () => isToolLine("● Edit(src/auth.js)")],
    then: ["is tool", (r) => expect(r).toBe(true)],
  });

  unit("matches Update (alias for Edit/Write)", {
    when: ["checking ● Update(...)", () => isToolLine("● Update(portfolio/DESIGN-CONCEPTS.md)")],
    then: ["is tool", (r) => expect(r).toBe(true)],
  });

  unit("matches Agent subagent call", {
    when: ["checking ● Agent(Explore)", () => isToolLine("● Agent(Explore)")],
    then: ["is tool", (r) => expect(r).toBe(true)],
  });

  unit("matches Wrote summary", {
    when: ["checking ● Wrote 45 lines", () => isToolLine("● Wrote 45 lines")],
    then: ["is tool", (r) => expect(r).toBe(true)],
  });

  unit("does not match text starting with ●", {
    when: ["checking text bullet", () => isToolLine("● The answer is 4.")],
    then: ["is not tool", (r) => expect(r).toBe(false)],
  });

  unit("does not match plain text", {
    when: ["checking plain text", () => isToolLine("Hello world")],
    then: ["is not tool", (r) => expect(r).toBe(false)],
  });
});

feature("isTextBullet", () => {
  unit("matches ● followed by normal text", {
    when: ["checking text bullet", () => isTextBullet("● The answer is 4.")],
    then: ["is text bullet", (r) => expect(r).toBe(true)],
  });

  unit("rejects tool call bullets", {
    when: ["checking tool bullet", () => isTextBullet("● Bash(npm test)")],
    then: ["is not text bullet", (r) => expect(r).toBe(false)],
  });

  unit("rejects Read summary bullet", {
    when: ["checking Read summary", () => isTextBullet("● Read 3 files (ctrl+o to expand)")],
    then: ["is not text bullet", (r) => expect(r).toBe(false)],
  });
});

// --- Full extraction from fixtures ---

feature("extractText: simple response", () => {
  unit("extracts plain text answer", {
    given: ["simple-text fixture", () => fixture("simple-text.txt")],
    when: ["extracting text", (raw) => extractText(raw)],
    then: ["returns the answer", (text) => {
      expect(text).toBe("The answer is 4.");
    }],
  });
});

feature("extractText: multi-text with tools", () => {
  unit("keeps all text blocks, strips tool calls", {
    given: ["multi-text-with-tools fixture", () => fixture("multi-text-with-tools.txt")],
    when: ["extracting text", (raw) => extractText(raw)],
    then: ["contains all text blocks, no tool output", (text) => {
      expect(text).toContain("Let me look at the auth file first.");
      expect(text).toContain("I see the issue.");
      expect(text).toContain("Fixed. The problem was");
      expect(text).not.toContain("Edit(");
      expect(text).not.toContain("Updated src/auth.js");
      expect(text).not.toContain("⎿");
      expect(text).not.toContain("if (token");
    }],
  });
});

feature("extractText: heavy tool spam", () => {
  unit("extracts text blocks between many tool calls", {
    given: ["heavy-tool-spam fixture", () => fixture("heavy-tool-spam.txt")],
    when: ["extracting text", (raw) => extractText(raw)],
    then: ["keeps intro and conclusion, strips all tools", (text) => {
      expect(text).toContain("I'll restructure the config module");
      expect(text).toContain("Now I'll create the new structure.");
      expect(text).toContain("Done. Restructured the config module");
      expect(text).toContain("All 8 tests pass.");
      expect(text).not.toContain("Bash(");
      expect(text).not.toContain("Write(");
      expect(text).not.toContain("PASS");
      expect(text).not.toContain("Wrote 45 lines");
    }],
  });
});

feature("extractText: edit diff leak", () => {
  unit("strips edit diffs and keeps conclusion", {
    given: ["edit-diff-leak fixture", () => fixture("edit-diff-leak.txt")],
    when: ["extracting text", (raw) => extractText(raw)],
    then: ["only text remains, no diff lines", (text) => {
      expect(text).toBe("Done. Added 6 new modules to the design document.");
      expect(text).not.toContain("Added 262 lines");
      expect(text).not.toContain("Moduler");
      expect(text).not.toContain("363 +");
    }],
  });
});

feature("extractText: empty response", () => {
  unit("returns null when no text output", {
    given: ["empty-response fixture", () => fixture("empty-response.txt")],
    when: ["extracting text", (raw) => extractText(raw)],
    then: ["returns null", (text) => expect(text).toBeNull()],
  });
});

feature("extractText: error output", () => {
  unit("keeps error explanation, strips tool error", {
    given: ["error-output fixture", () => fixture("error-output.txt")],
    when: ["extracting text", (raw) => extractText(raw)],
    then: ["contains explanation, not raw error", (text) => {
      expect(text).toContain("deploy failed");
      expect(text).toContain("server at the deploy target");
      expect(text).not.toContain("Bash(");
      expect(text).not.toContain("ECONNREFUSED");
    }],
  });
});

feature("extractText: UI noise", () => {
  unit("strips survey, agent log hint, and tool summaries", {
    given: ["ui-noise fixture", () => fixture("ui-noise.txt")],
    when: ["extracting text", (raw) => extractText(raw)],
    then: ["only explanation text remains", (text) => {
      expect(text).toContain("Node.js Discord bot");
      expect(text).toContain("key files are");
      expect(text).not.toContain("How is Claude doing");
      expect(text).not.toContain("Dismiss");
      expect(text).not.toContain("agent log");
    }],
  });
});

feature("extractText: multi-turn history", () => {
  unit("only extracts the last turn", {
    given: ["multi-turn-history fixture", () => fixture("multi-turn-history.txt")],
    when: ["extracting text", (raw) => extractText(raw)],
    then: ["only last answer, not first", (text) => {
      expect(text).toContain("Rust is a systems programming language");
      expect(text).not.toContain("TypeScript");
    }],
  });
});

feature("extractText: startup garbage", () => {
  unit("strips cd, conda, Claude banner", {
    given: ["startup-garbage fixture", () => fixture("startup-garbage.txt")],
    when: ["extracting text", (raw) => extractText(raw)],
    then: ["only greeting remains", (text) => {
      expect(text).toBe("Hi! How can I help you today?");
    }],
  });
});

feature("extractText: agent subagent", () => {
  unit("strips Agent() call and result, keeps surrounding text", {
    given: ["agent-subagent fixture", () => fixture("agent-subagent.txt")],
    when: ["extracting text", (raw) => extractText(raw)],
    then: ["keeps intro and conclusion, strips agent call", (text) => {
      expect(text).toContain("I'll research this for you.");
      expect(text).toContain("Deno has native WebSocket support");
      expect(text).toContain("src/ws.ts");
      expect(text).not.toContain("Agent(Explore)");
    }],
  });
});

feature("extractText: tool results with non-breaking space indent", () => {
  unit("classifies '⎿  Found 0 files' as tool when indented with U+00A0", {
    given: ["line with U+00A0 indent", () => [
      "❯ test",
      "",
      "● Search(pattern: \"**/x\")",
      "\u00a0\u00a0⎿ \u00a0Found 0 files",
      "",
      "● Not found.",
    ].join("\n")],
    when: ["classifying", (raw) => classifyLines(raw)],
    then: ["⎿ line is tool, not text", (lines) => {
      // Find the ⎿ line
      const toolResult = lines.find((l) => l.content.includes("Found 0 files"));
      expect(toolResult.type).toBe("tool");
    }],
  });
});

feature("extract: codex dialect (• bullet, └ tool result, verb tool calls)", () => {
  unit("extracts text + tool + text in order for codex output", {
    given: ["codex multi-tool fixture", () => fixture("codex-multi-tool.txt")],
    when: ["extracting mixed stream", (raw) => extractMixedStream(classifyLines(raw))],
    then: ["3 items: text, tool, text - no status bar leak", (items) => {
      expect(items).toHaveLength(3);
      expect(items[0]).toEqual({ type: "text", content: "Jag kör date igen och återger tiden i en mening." });
      expect(items[1]).toEqual({ type: "tool", content: "Ran date '+%H:%M %Z'" });
      expect(items[2]).toEqual({ type: "text", content: "Klockan är 19:11 CEST." });
      // Status bar not in any text
      const joined = items.map((i) => i.content).join(" ");
      expect(joined).not.toContain("gpt-5.4");
      expect(joined).not.toContain("Find and fix a bug");
      expect(joined).not.toContain("•");   // bullet should be stripped
    }],
  });

  unit("strips • bullet from codex text", {
    given: ["simple codex text", () => "› hej\n\n• Stockholm\n\n  gpt-5.4 xhigh · 100% left · ~/x"],
    when: ["extracting text", (raw) => extractText(raw)],
    then: ["bullet stripped, status bar removed", (text) => {
      expect(text).toBe("Stockholm");
    }],
  });
});

feature("extractText: Claude Code v2.1.96 bottom status bar", () => {
  unit("strips 'N tokens' counter and '● high · /effort' status", {
    given: ["v2196-status fixture", () => fixture("claude-v2196-status-bar.txt")],
    when: ["extracting text", (raw) => extractText(raw)],
    then: ["only the actual response remains", (text) => {
      expect(text).toBe("Claw 🦀");
      expect(text).not.toContain("27257 tokens");
      expect(text).not.toContain("tokens");
      expect(text).not.toContain("/effort");
      expect(text).not.toContain("bypass permissions");
    }],
  });
});

// --- classifyLines ---

feature("classifyLines", () => {
  unit("classifies mixed content correctly", {
    given: ["mixed lines", () => [
      "❯ test prompt",
      "● Let me check.",
      "● Bash(ls)",
      "  ⎿  file.txt",
      "● Done.",
      "",
      "✻ Brewed for 2s",
    ].join("\n")],
    when: ["classifying", (raw) => classifyLines(raw)],
    then: ["each line has correct type", (lines) => {
      const types = lines.map((l) => l.type);
      expect(types).toEqual(["noise", "text", "tool", "tool", "text", "empty", "noise"]);
    }],
  });

  unit("injected attachments are noise", {
    given: ["attachment line", () => "[image attached: /tmp/discord-media-123.png]"],
    when: ["classifying", (raw) => classifyLines(raw)],
    then: ["is noise", (lines) => expect(lines[0].type).toBe("noise")],
  });

  unit("continuation lines follow their block", {
    given: ["text with continuation", () => [
      "● Here is the explanation:",
      "  First point",
      "  Second point",
      "● Bash(test)",
      "  ⎿  output line 1",
      "     output line 2",
      "● All done.",
    ].join("\n")],
    when: ["classifying", (raw) => classifyLines(raw)],
    then: ["continuation follows parent block type", (lines) => {
      const types = lines.map((l) => l.type);
      expect(types).toEqual(["text", "text", "text", "tool", "tool", "tool", "text"]);
    }],
  });
});

// --- extractSegments ---

feature("extractSegments", () => {
  unit("splits text at tool boundaries", {
    given: ["text-tool-text sequence", () => classifyLines([
      "● First block.",
      "● Bash(ls)",
      "  ⎿  file.txt",
      "● Second block.",
    ].join("\n"))],
    when: ["extracting segments", (cl) => extractSegments(cl)],
    then: ["returns two segments", (segs) => {
      expect(segs).toEqual(["First block.", "Second block."]);
    }],
  });

  unit("keeps empty lines within a segment", {
    given: ["text with blank line then more text", () => classifyLines([
      "● Header:",
      "  1. first item",
      "  2. second item",
      "",
      "  Conclusion here.",
      "● Bash(test)",
    ].join("\n"))],
    when: ["extracting segments", (cl) => extractSegments(cl)],
    then: ["all text is one segment with blank line preserved", (segs) => {
      expect(segs).toHaveLength(1);
      expect(segs[0]).toContain("Header:");
      expect(segs[0]).toContain("1. first item");
      expect(segs[0]).toContain("2. second item");
      expect(segs[0]).toContain("Conclusion here.");
    }],
  });

  unit("handles multiple tool calls between text", {
    given: ["text-tool-tool-text", () => classifyLines([
      "● Let me check.",
      "● Read 1 file (ctrl+o to expand)",
      "● Bash(npm test)",
      "  ⎿  PASS",
      "● All tests pass.",
    ].join("\n"))],
    when: ["extracting segments", (cl) => extractSegments(cl)],
    then: ["returns two segments", (segs) => {
      expect(segs).toEqual(["Let me check.", "All tests pass."]);
    }],
  });

  unit("returns empty array for tool-only output", {
    given: ["only tool calls", () => classifyLines([
      "● Bash(ls)",
      "  ⎿  file.txt",
    ].join("\n"))],
    when: ["extracting segments", (cl) => extractSegments(cl)],
    then: ["returns empty", (segs) => expect(segs).toEqual([])],
  });

  unit("single text block is one segment", {
    given: ["just text", () => classifyLines("● The answer is 42.")],
    when: ["extracting segments", (cl) => extractSegments(cl)],
    then: ["one segment", (segs) => expect(segs).toEqual(["The answer is 42."])],
  });

  unit("filters injected attachments between segments", {
    given: ["text with injected attachment", () => classifyLines([
      "● First response.",
      "● Bash(ls)",
      "  ⎿  ok",
      "[image attached: /tmp/discord-media-123.png]",
      "● Second response.",
    ].join("\n"))],
    when: ["extracting segments", (cl) => extractSegments(cl)],
    then: ["attachment not in any segment", (segs) => {
      expect(segs).toEqual(["First response.", "Second response."]);
    }],
  });
});
