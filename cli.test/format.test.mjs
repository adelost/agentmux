import { feature, unit, expect } from "bdd-vitest";
import { detectPaneStatus, statusIcon, formatAgentRow, truncate } from "../cli/format.mjs";

feature("detectPaneStatus", () => {
  unit("detects working state", {
    given: ["pane with esc to interrupt", () => "some output\n  esc to interrupt\n"],
    when: ["detecting", detectPaneStatus],
    then: ["returns working", (s) => expect(s).toBe("working")],
  });

  unit("detects token-stream footer as working", {
    given: ["pane mid-stream with token-count footer", () =>
      "✻ Sautéed for 2m 30s\n  (2m 30s · ↓ 7.2k tokens)\n"],
    when: ["detecting", detectPaneStatus],
    then: ["returns working — spinner footer with middot is live",
      (s) => expect(s).toBe("working")],
  });

  unit("detects pre-token thinking footer as working", {
    given: ["pane mid-thought, no tokens emitted yet", () =>
      "✢ Finagling… (17s · still thinking with xhigh effort)\n"],
    when: ["detecting", detectPaneStatus],
    then: ["returns working — thinking phase shows footer without tokens",
      (s) => expect(s).toBe("working")],
  });

  unit("detects 'thought for X' footer as working", {
    given: ["pane mid-stream after thinking", () =>
      "✻ Cogitated for 46s\n  (10m 27s · thought for 2s)\n"],
    when: ["detecting", detectPaneStatus],
    then: ["returns working", (s) => expect(s).toBe("working")],
  });

  unit("idle pane with bare-time mention does NOT classify working", {
    given: ["pane where natural content includes (15s) without middot", () =>
      "after waiting (15s), the response landed\n────\n❯ \n  bypass permissions on\n"],
    when: ["detecting", detectPaneStatus],
    then: ["returns idle — bare '(Ns)' without middot is content, not spinner footer",
      (s) => expect(s).toBe("idle")],
  });

  unit("ambiguous spinner ('Sautéed for X') alone does not classify working", {
    given: ["pane with past-participle spinner + idle prompt", () =>
      "✻ Sautéed for 1m 48s\n────\n❯ \n  bypass permissions on\n"],
    when: ["detecting", detectPaneStatus],
    then: ["returns idle (past-participle 'for X' is ambiguous; jsonl-mtime overlay handles it at call site)",
      (s) => expect(s).toBe("idle")],
  });

  unit("idle pane with old spinner in scrollback returns idle", {
    given: ["pane where spinner is in scrollback above prompt", () =>
      "✻ Sautéed for 3m 46s\n  ⎿  Running… (7m 38s · timeout 10m)\n" +
      "✻ Cooked for 38s\n" +
      "result text from previous turn\n".repeat(20) +
      "\n────\n❯ \n────\n  Opus 4.7 (1M context) │ 0\n  ⏵⏵ bypass permissions on\n"],
    when: ["detecting", detectPaneStatus],
    then: ["returns idle (no esc-to-interrupt)", (s) => expect(s).toBe("idle")],
  });

  unit("detects permission state", {
    given: ["pane with Allow once", () => "Allow once  Allow always\n"],
    when: ["detecting", detectPaneStatus],
    then: ["returns permission", (s) => expect(s).toBe("permission")],
  });

  unit("detects menu state", {
    given: ["pane with Enter to select", () => "1. Option\nEnter to select\n"],
    when: ["detecting", detectPaneStatus],
    then: ["returns menu", (s) => expect(s).toBe("menu")],
  });

  unit("detects resume state", {
    given: ["pane with resume prompt", () => "Resume from summary\nEnter to confirm\n"],
    when: ["detecting", detectPaneStatus],
    then: ["returns resume", (s) => expect(s).toBe("resume")],
  });

  unit("detects dismiss state", {
    given: ["pane with dismiss", () => "1: Bad  2: Fine\n0: Dismiss\n"],
    when: ["detecting", detectPaneStatus],
    then: ["returns dismiss", (s) => expect(s).toBe("dismiss")],
  });

  unit("'0: Dismiss' as scrollback content (not modal) does not classify dismiss", {
    given: ["pane discussing dismiss-bug in its turn output, with idle prompt at tail",
      () => "agent diagnosing a substring-match bug:\n" +
            "the regex /0: Dismiss/.test(text) matches anywhere — false positive\n" +
            "fix: anchor to tail or require menu-box markers\n".repeat(20) +
            "✢ Unravelling…\n────\n❯ \n  ⏵⏵ bypass permissions on\n"],
    when: ["detecting", detectPaneStatus],
    then: ["returns idle (modal text appears as content far from tail, not as live modal)",
      (s) => expect(s).toBe("idle")],
  });

  unit("'Resume from summary' in scrollback does not classify resume", {
    given: ["pane discussing /resume in its turn output, with idle prompt",
      () => "agent explained:\n" +
            "if the user runs /resume from summary, claude reloads the prior turn\n".repeat(20) +
            "\n────\n❯ \n  ⏵⏵ bypass permissions on\n"],
    when: ["detecting", detectPaneStatus],
    then: ["returns idle (text is content, not active modal)",
      (s) => expect(s).toBe("idle")],
  });

  unit("'Enter to select' in scrollback does not classify menu", {
    given: ["pane explaining menu-keybindings in turn output",
      () => "documenting:\n" +
            "press Enter to select an option from the list\n".repeat(20) +
            "\n────\n❯ \n  ⏵⏵ bypass permissions on\n"],
    when: ["detecting", detectPaneStatus],
    then: ["returns idle", (s) => expect(s).toBe("idle")],
  });

  unit("detects idle state", {
    given: ["pane with prompt", () => "some output\n❯ \nbypass permissions on\n"],
    when: ["detecting", detectPaneStatus],
    then: ["returns idle", (s) => expect(s).toBe("idle")],
  });

  unit("returns unknown for empty", {
    given: ["empty pane", () => ""],
    when: ["detecting", detectPaneStatus],
    then: ["returns unknown", (s) => expect(s).toBe("unknown")],
  });
});

feature("statusIcon", () => {
  unit("working = green", {
    given: ["working status", () => "working"],
    when: ["getting icon", statusIcon],
    then: ["returns green circle", (i) => expect(i).toBe("🟢")],
  });

  unit("idle = sleep", {
    given: ["idle status", () => "idle"],
    when: ["getting icon", statusIcon],
    then: ["returns sleep", (i) => expect(i).toBe("💤")],
  });

  unit("permission = red", {
    given: ["permission status", () => "permission"],
    when: ["getting icon", statusIcon],
    then: ["returns red", (i) => expect(i).toBe("🔴")],
  });
});

feature("formatAgentRow", () => {
  unit("formats running agent", {
    given: ["agent info", () => ({ i: 1, n: "ai", d: "/home/user/ai", r: true, p: 5 })],
    when: ["formatting", ({ i, n, d, r, p }) => formatAgentRow(i, n, d, r, p)],
    then: ["contains all parts", (row) => {
      expect(row).toContain("1");
      expect(row).toContain("ai");
      expect(row).toContain("/home/user/ai");
      expect(row).toContain("●");
      expect(row).toContain("5 panes");
    }],
  });

  unit("formats stopped agent without pane count", {
    given: ["single-pane agent", () => ({ i: 2, n: "tmp", d: "/tmp", r: false, p: 1 })],
    when: ["formatting", ({ i, n, d, r, p }) => formatAgentRow(i, n, d, r, p)],
    then: ["no pane count shown", (row) => {
      expect(row).toContain("○");
      expect(row).not.toContain("panes");
    }],
  });
});

feature("truncate", () => {
  unit("short string unchanged", {
    given: ["short string", () => "hello"],
    when: ["truncating to 10", (s) => truncate(s, 10)],
    then: ["unchanged", (r) => expect(r).toBe("hello")],
  });

  unit("long string truncated with ellipsis", {
    given: ["long string", () => "a".repeat(100)],
    when: ["truncating to 10", (s) => truncate(s, 10)],
    then: ["9 chars + ellipsis", (r) => {
      expect(r).toHaveLength(10);
      expect(r.endsWith("…")).toBe(true);
    }],
  });
});
