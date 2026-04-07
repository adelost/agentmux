import { feature, unit, expect } from "bdd-vitest";
import { formatToolCall, extractMixedStream, classifyLines } from "../core/extract.mjs";

feature("formatToolCall", () => {
  unit("Bash with simple command", {
    given: ["bash tool call", () => "● Bash(cd /skybar && pwd)"],
    when: ["formatting", formatToolCall],
    then: ["returns Bash cd ...", (r) => expect(r).toBe("Bash cd /skybar && pwd")],
  });

  unit("Bash truncates long commands", {
    given: ["long bash", () => `● Bash(${'a'.repeat(200)})`],
    when: ["formatting", formatToolCall],
    then: ["truncated with ellipsis", (r) => {
      expect(r.length).toBeLessThanOrEqual(90);
      expect(r).toContain("...");
    }],
  });

  unit("Read with simple file", {
    given: ["read tool", () => "● Read(file.ts)"],
    when: ["formatting", formatToolCall],
    then: ["returns Read file.ts", (r) => expect(r).toBe("Read file.ts")],
  });

  unit("Read with long path truncates middle", {
    given: ["deep path", () => "● Read(src/routes/cafe/components/CafeHeader.svelte)"],
    when: ["formatting", formatToolCall],
    then: ["shortens to .../parent/file", (r) => expect(r).toContain("...")],
  });

  unit("Edit with diff", {
    given: ["edit tool", () => "● Edit(file.svelte)"],
    when: ["formatting", formatToolCall],
    then: ["returns Edit file.svelte", (r) => expect(r).toBe("Edit file.svelte")],
  });

  unit("Glob with pattern", {
    given: ["glob", () => "● Glob(**/*.ts)"],
    when: ["formatting", formatToolCall],
    then: ["returns Glob pattern", (r) => expect(r).toBe("Glob **/*.ts")],
  });

  unit("Unknown tool passes through", {
    given: ["custom tool", () => "● TodoWrite(some args)"],
    when: ["formatting", formatToolCall],
    then: ["returns Tool args", (r) => expect(r).toBe("TodoWrite some args")],
  });
});

feature("extractMixedStream", () => {
  const SAMPLE = `❯ test prompt

● Let me check the file.

● Read(src/file.ts)
  ⎿  read 50 lines

● I'll edit it now.

● Edit(src/file.ts)
  ⎿  +1, -1

● Done.`;

  unit("returns text and tools in order", {
    given: ["sample claude output", () => classifyLines(SAMPLE)],
    when: ["extracting stream", extractMixedStream],
    then: ["text → tool → text → tool → text", (items) => {
      expect(items).toHaveLength(5);
      expect(items[0]).toEqual({ type: "text", content: "Let me check the file." });
      expect(items[1]).toEqual({ type: "tool", content: "Read src/file.ts" });
      expect(items[2]).toEqual({ type: "text", content: "I'll edit it now." });
      expect(items[3]).toEqual({ type: "tool", content: "Edit src/file.ts" });
      expect(items[4]).toEqual({ type: "text", content: "Done." });
    }],
  });

  unit("skips tool results (⎿ lines)", {
    given: ["output with tool results", () => classifyLines("● Read(file.ts)\n  ⎿  50 lines\n  ⎿  another result")],
    when: ["extracting", extractMixedStream],
    then: ["only one tool item, no result lines", (items) => {
      expect(items).toHaveLength(1);
      expect(items[0].type).toBe("tool");
    }],
  });

  unit("multiple tool calls in sequence", {
    given: ["3 tools in a row", () => classifyLines("● Read(a.ts)\n● Read(b.ts)\n● Read(c.ts)")],
    when: ["extracting", extractMixedStream],
    then: ["3 tool items", (items) => {
      expect(items).toHaveLength(3);
      expect(items.every((i) => i.type === "tool")).toBe(true);
    }],
  });
});
