import { feature, unit, expect } from "bdd-vitest";
import { detectPaneStatus } from "../cli/format.mjs";

feature("pane status detection", () => {
  unit("treats compacting with a visible prompt and queued message as working", {
    given: ["Claude compact UI with queued prompt", () => [
      "❯ /compact",
      "",
      "* Compacting conversation… (1m 31s)",
      "  ▰▰▰▰▰▰▰▱ 64%",
      "",
      "  ❯ [dream 2026-05-13 13:33]",
      "────────────────────────────────────────────────────────────────────────────",
      "❯ Press up to edit queued messages",
      "────────────────────────────────────────────────────────────────────────────",
    ].join("\n")],
    when: ["detecting pane status", (content) => detectPaneStatus(content)],
    then: ["status is working, not idle", (status) => {
      expect(status).toBe("working");
    }],
  });

  unit("treats a narrow-pane spinner footer (no middot) as working", {
    given: ["long-running turn in a split pane — footer dropped its '· tokens · esc' sub-info", () => [
      "  Branch p7/routes pushad → commit 458cb4a.",
      "",
      "✢ Pondering… (42m 53s)",
      "",
      "  ❯ /compact",
    ].join("\n")],
    when: ["detecting pane status", (content) => detectPaneStatus(content)],
    then: ["status is working, not idle (composer prompt is visible but the timer wins)", (status) => {
      expect(status).toBe("working");
    }],
  });

  unit("treats a seconds-only narrow footer (ellipsis + timer) as working", {
    given: ["short turn, narrow pane, ellipsis-then-timer footer", () => [
      "  some output",
      "",
      "✽ Beboppin'… (8s)",
      "  ❯ ",
    ].join("\n")],
    when: ["detecting pane status", (content) => detectPaneStatus(content)],
    then: ["status is working", (status) => {
      expect(status).toBe("working");
    }],
  });

  unit("does not false-positive seconds-shaped scrollback as working", {
    given: ["idle pane whose scrollback mentions a duration but has no live spinner footer", () => [
      "The request took (15s) to complete and returned 200.",
      "",
      "❯ ",
    ].join("\n")],
    when: ["detecting pane status", (content) => detectPaneStatus(content)],
    then: ["status is idle", (status) => {
      expect(status).toBe("idle");
    }],
  });

  unit("still treats a plain visible prompt as idle", {
    given: ["normal idle composer", () => [
      "Done with previous task.",
      "",
      "❯ ",
    ].join("\n")],
    when: ["detecting pane status", (content) => detectPaneStatus(content)],
    then: ["status is idle", (status) => {
      expect(status).toBe("idle");
    }],
  });

  unit("flags a dead codex turn as interrupted, not idle (ai:4 2026-07-08)", {
    given: ["codex after a stream error killed the turn — banner at tail", () => [
      "• bdd-pytest finns som sibling under /home/adelost/lsrc, så /tmp-",
      "",
      "⚠",
      "•",
      "■ Conversation interrupted - tell the model what to do differently",
    ].join("\n")],
    when: ["detecting pane status", (content) => detectPaneStatus(content)],
    then: ["status is interrupted — done/ps must show the ball is dropped", (status) => {
      expect(status).toBe("interrupted");
    }],
  });

  unit("interrupted banner + visible composer is still interrupted, not idle", {
    given: ["codex interrupted with the composer re-rendered below", () => [
      "■ Conversation interrupted - tell the model what to do differently",
      "",
      "› ",
    ].join("\n")],
    when: ["detecting pane status", (content) => detectPaneStatus(content)],
    then: ["interrupted wins over the prompt-first idle check", (status) => {
      expect(status).toBe("interrupted");
    }],
  });

  unit("a pane that resumed working after an interruption is working", {
    given: ["banner residue in tail but a live turn is running", () => [
      "■ Conversation interrupted - tell the model what to do differently",
      "",
      "• Working (12s · esc to interrupt)",
    ].join("\n")],
    when: ["detecting pane status", (content) => detectPaneStatus(content)],
    then: ["working wins — banner is scrollback residue", (status) => {
      expect(status).toBe("working");
    }],
  });
});

