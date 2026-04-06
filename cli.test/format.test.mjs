import { feature, unit, expect } from "bdd-vitest";
import { detectPaneStatus, statusIcon, formatAgentRow, truncate } from "../cli/format.mjs";

feature("detectPaneStatus", () => {
  unit("detects working state", {
    given: ["pane with esc to interrupt", () => "some output\n  esc to interrupt\n"],
    when: ["detecting", detectPaneStatus],
    then: ["returns working", (s) => expect(s).toBe("working")],
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
