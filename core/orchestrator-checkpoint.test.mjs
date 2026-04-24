import { unit, feature, expect } from "bdd-vitest";
import { unlinkSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  loadCheckpoint,
  saveCheckpoint,
  groupByPane,
  classifyPane,
  isWaitingLikeText,
  previewText,
  isStaleWaiter,
  isRunningNow,
} from "./orchestrator-checkpoint.mjs";

const tmpPath = () =>
  join(tmpdir(), `amux-checkpoint-test-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
const cleanup = (path) => { try { unlinkSync(path); } catch {} };

const row = (agent, pane, role, content, timestamp, type = "text") => ({
  agent, pane, role, content, timestamp, type,
});

feature("loadCheckpoint / saveCheckpoint", () => {
  unit("loadCheckpoint returns null when file missing", {
    given: ["a fresh path", () => ({ path: tmpPath() })],
    when: ["loading", ({ path }) => loadCheckpoint(path)],
    then: ["returns null", (result) => expect(result).toBeNull()],
  });

  unit("saveCheckpoint + loadCheckpoint roundtrip", {
    given: ["a path and timestamp", () => ({ path: tmpPath(), ts: 1_700_000_000_000 })],
    when: ["save then load", ({ path, ts }) => {
      saveCheckpoint(ts, path);
      const loaded = loadCheckpoint(path);
      cleanup(path);
      return loaded;
    }],
    then: ["loaded value matches saved", (result) => expect(result).toBe(1_700_000_000_000)],
  });

  unit("loadCheckpoint returns null for malformed file", {
    given: ["a path with garbage", () => {
      const path = tmpPath();
      saveCheckpoint(42, path);
      // corrupt it
      const { writeFileSync } = require("fs");
      writeFileSync(path, "not json");
      return { path };
    }],
    when: ["loading", ({ path }) => loadCheckpoint(path)],
    then: ["returns null (safe fallback)", (result, { path }) => {
      cleanup(path);
      expect(result).toBeNull();
    }],
  });

  unit("loadCheckpoint returns null when field missing", {
    given: ["a path with wrong shape", () => {
      const path = tmpPath();
      const { writeFileSync } = require("fs");
      writeFileSync(path, JSON.stringify({ other: "field" }));
      return { path };
    }],
    when: ["loading", ({ path }) => loadCheckpoint(path)],
    then: ["returns null", (result, { path }) => {
      cleanup(path);
      expect(result).toBeNull();
    }],
  });
});

feature("groupByPane", () => {
  unit("returns empty map for no rows", {
    given: ["no rows", () => ({ rows: [] })],
    when: ["grouping", ({ rows }) => groupByPane(rows)],
    then: ["empty map", (result) => expect(result.size).toBe(0)],
  });

  unit("groups rows by agent:pane key", {
    given: ["rows from 2 panes", () => ({
      rows: [
        row("claw", 0, "user", "hi", "2026-04-23T10:00:00Z"),
        row("claw", 5, "user", "deploy", "2026-04-23T10:05:00Z"),
        row("claw", 5, "assistant", "done", "2026-04-23T10:06:00Z"),
      ],
    })],
    when: ["grouping", ({ rows }) => groupByPane(rows)],
    then: ["two buckets with correct turn counts", (result) => {
      expect(result.size).toBe(2);
      expect(result.get("claw:0").turns).toBe(1);
      expect(result.get("claw:5").turns).toBe(2);
    }],
  });

  unit("tracks latest user and assistant text separately", {
    given: ["interleaved user+assistant rows", () => ({
      rows: [
        row("claw", 5, "user", "first ask", "2026-04-23T10:00:00Z"),
        row("claw", 5, "assistant", "first answer", "2026-04-23T10:01:00Z"),
        row("claw", 5, "user", "follow up", "2026-04-23T10:02:00Z"),
        row("claw", 5, "assistant", "final answer", "2026-04-23T10:03:00Z"),
      ],
    })],
    when: ["grouping", ({ rows }) => groupByPane(rows)],
    then: ["last user + last assistant both captured", (result) => {
      const b = result.get("claw:5");
      expect(b.lastUserText).toBe("follow up");
      expect(b.lastAssistantText).toBe("final answer");
    }],
  });

  unit("records latest timestamp from any row", {
    given: ["rows with varying ts", () => ({
      rows: [
        row("claw", 0, "user", "a", "2026-04-23T10:00:00Z"),
        row("claw", 0, "user", "b", "2026-04-23T11:00:00Z"),
      ],
    })],
    when: ["grouping", ({ rows }) => groupByPane(rows)],
    then: ["latestTurnTs is newest", (result) => {
      const b = result.get("claw:0");
      expect(b.latestTurnTs).toBe(Date.parse("2026-04-23T11:00:00Z"));
    }],
  });

  unit("tool-type rows count toward turns but not text slots", {
    given: ["tool-only activity", () => ({
      rows: [
        row("claw", 5, "user", "do it", "2026-04-23T10:00:00Z", "text"),
        row("claw", 5, "assistant", null, "2026-04-23T10:01:00Z", "tool"),
      ],
    })],
    when: ["grouping", ({ rows }) => groupByPane(rows)],
    then: ["turns=2 but lastAssistantText stays null", (result) => {
      const b = result.get("claw:5");
      expect(b.turns).toBe(2);
      expect(b.lastAssistantText).toBeNull();
    }],
  });
});

feature("isWaitingLikeText", () => {
  unit("returns false for empty / null", {
    given: ["no content", () => ({ texts: [null, "", "   "] })],
    when: ["checking each", ({ texts }) => texts.map(isWaitingLikeText)],
    then: ["all false", (result) => expect(result).toEqual([false, false, false])],
  });

  unit("trailing question mark triggers waiting", {
    given: ["text ending in ?", () => ({ text: "Should I proceed with the deploy?" })],
    when: ["checking", ({ text }) => isWaitingLikeText(text)],
    then: ["waiting", (result) => expect(result).toBe(true)],
  });

  unit("Swedish 'säg skippa/fixa' cue triggers waiting", {
    given: ["user-prompt Swedish pattern", () => ({
      text: "Tre items att städa. Säg skippa, fixa alla, eller punkt-för-punkt.",
    })],
    when: ["checking", ({ text }) => isWaitingLikeText(text)],
    then: ["waiting", (result) => expect(result).toBe(true)],
  });

  unit("'bekräfta' cue triggers waiting", {
    given: ["confirmation request", () => ({ text: "Bekräfta före jag kör borttagningen." })],
    when: ["checking", ({ text }) => isWaitingLikeText(text)],
    then: ["waiting", (result) => expect(result).toBe(true)],
  });

  unit("English 'want me to' cue triggers waiting", {
    given: ["English want-me-to", () => ({ text: "I can run the migration. Want me to do it now." })],
    when: ["checking", ({ text }) => isWaitingLikeText(text)],
    then: ["waiting", (result) => expect(result).toBe(true)],
  });

  unit("plain status message does NOT trigger waiting", {
    given: ["finished-work message", () => ({ text: "Committed d628a3b. All 587 tests pass." })],
    when: ["checking", ({ text }) => isWaitingLikeText(text)],
    then: ["not waiting", (result) => expect(result).toBe(false)],
  });

  unit("question in middle with declarative end does NOT trigger", {
    given: ["question buried, then statement", () => ({
      text: "I asked? earlier but resolved it myself. All done.",
    })],
    when: ["checking", ({ text }) => isWaitingLikeText(text)],
    then: ["not waiting", (result) => expect(result).toBe(false)],
  });
});

feature("classifyPane", () => {
  const emptyBucket = { turns: 0, lastAssistantText: null, lastUserText: null };

  unit("returns 'still-working' when paneStatus=working", {
    given: ["working pane", () => ({ b: emptyBucket, status: "working" })],
    when: ["classifying", ({ b, status }) => classifyPane(b, status)],
    then: ["still-working", (r) => expect(r).toBe("still-working")],
  });

  unit("returns 'waiting' when paneStatus=menu (modal dialog)", {
    given: ["menu pane", () => ({ b: emptyBucket, status: "menu" })],
    when: ["classifying", ({ b, status }) => classifyPane(b, status)],
    then: ["waiting", (r) => expect(r).toBe("waiting")],
  });

  unit("returns 'idle' when no turns since cutoff", {
    given: ["bucket with 0 turns", () => ({ b: { ...emptyBucket, turns: 0 }, status: "idle" })],
    when: ["classifying", ({ b, status }) => classifyPane(b, status)],
    then: ["idle", (r) => expect(r).toBe("idle")],
  });

  unit("returns 'waiting' when last assistant text ends with '?'", {
    given: ["pane with question-ending msg", () => ({
      b: { turns: 3, lastAssistantText: "Should I proceed?", lastUserText: null },
      status: "idle",
    })],
    when: ["classifying", ({ b, status }) => classifyPane(b, status)],
    then: ["waiting", (r) => expect(r).toBe("waiting")],
  });

  unit("returns 'finished' when idle + turns + non-question last msg", {
    given: ["committed-work message", () => ({
      b: { turns: 5, lastAssistantText: "Committed d628a3b, 20/20 tests pass.", lastUserText: null },
      status: "idle",
    })],
    when: ["classifying", ({ b, status }) => classifyPane(b, status)],
    then: ["finished", (r) => expect(r).toBe("finished")],
  });

  unit("still-working wins over waiting-like-text", {
    given: ["working pane with question-ending message", () => ({
      b: { turns: 2, lastAssistantText: "Should I continue?", lastUserText: null },
      status: "working",
    })],
    when: ["classifying", ({ b, status }) => classifyPane(b, status)],
    then: ["still-working (active run outranks)", (r) => expect(r).toBe("still-working")],
  });
});

feature("previewText", () => {
  unit("returns empty for null/empty", {
    given: ["no content", () => ({ t: null })],
    when: ["previewing", ({ t }) => previewText(t)],
    then: ["empty", (r) => expect(r).toBe("")],
  });

  unit("short text returned as-is", {
    given: ["short msg", () => ({ t: "hello world" })],
    when: ["previewing", ({ t }) => previewText(t)],
    then: ["unchanged", (r) => expect(r).toBe("hello world")],
  });

  unit("collapses whitespace + newlines to single spaces", {
    given: ["multiline msg", () => ({ t: "line 1\n  line 2\t\tline 3" })],
    when: ["previewing", ({ t }) => previewText(t)],
    then: ["single-line collapsed", (r) => expect(r).toBe("line 1 line 2 line 3")],
  });

  unit("long text trimmed with ellipsis", {
    given: ["200-char msg", () => ({ t: "a".repeat(200) })],
    when: ["previewing", ({ t }) => previewText(t, 80)],
    then: ["80 chars with …", (r) => {
      expect(r.length).toBe(80);
      expect(r.endsWith("…")).toBe(true);
    }],
  });
});

feature("groupByPane tracks lastAssistantTextTs", () => {
  unit("captures timestamp of latest assistant text row", {
    given: ["multiple text rows", () => ({
      rows: [
        row("claw", 0, "assistant", "early", "2026-04-23T10:00:00Z"),
        row("claw", 0, "assistant", "late", "2026-04-23T11:00:00Z"),
      ],
    })],
    when: ["grouping", ({ rows }) => groupByPane(rows)],
    then: ["lastAssistantTextTs = late row", (result) => {
      const b = result.get("claw:0");
      expect(b.lastAssistantTextTs).toBe(Date.parse("2026-04-23T11:00:00Z"));
    }],
  });

  unit("lastAssistantTextTs stays null when only tool rows", {
    given: ["tool-only rows", () => ({
      rows: [row("claw", 0, "assistant", null, "2026-04-23T10:00:00Z", "tool")],
    })],
    when: ["grouping", ({ rows }) => groupByPane(rows)],
    then: ["null", (result) => {
      const b = result.get("claw:0");
      expect(b.lastAssistantTextTs).toBeNull();
    }],
  });

  unit("latestTurnTs can exceed lastAssistantTextTs (tool activity after text)", {
    given: ["text then tool activity after", () => ({
      rows: [
        row("claw", 0, "assistant", "said something", "2026-04-23T10:00:00Z", "text"),
        row("claw", 0, "assistant", null, "2026-04-23T10:05:00Z", "tool"),
      ],
    })],
    when: ["grouping", ({ rows }) => groupByPane(rows)],
    then: ["text ts frozen, latest ts advanced", (result) => {
      const b = result.get("claw:0");
      expect(b.lastAssistantTextTs).toBe(Date.parse("2026-04-23T10:00:00Z"));
      expect(b.latestTurnTs).toBe(Date.parse("2026-04-23T10:05:00Z"));
    }],
  });
});

feature("isStaleWaiter", () => {
  const bucket = (ts) => ({ lastAssistantTextTs: ts });

  unit("returns true when no timestamp", {
    given: ["bucket without ts", () => ({ b: bucket(null), since: 1000 })],
    when: ["checking", ({ b, since }) => isStaleWaiter(b, since)],
    then: ["stale", (r) => expect(r).toBe(true)],
  });

  unit("returns true when text older than checkpoint", {
    given: ["old text", () => ({ b: bucket(500), since: 1000 })],
    when: ["checking", ({ b, since }) => isStaleWaiter(b, since)],
    then: ["stale", (r) => expect(r).toBe(true)],
  });

  unit("returns false when text at or after checkpoint", {
    given: ["fresh text", () => ({ b: bucket(2000), since: 1000 })],
    when: ["checking", ({ b, since }) => isStaleWaiter(b, since)],
    then: ["not stale", (r) => expect(r).toBe(false)],
  });

  unit("returns false for missing bucket + infinite since", {
    given: ["no bucket", () => ({ b: null, since: NaN })],
    when: ["checking", ({ b, since }) => isStaleWaiter(b, since)],
    then: ["safe false", (r) => expect(r).toBe(false)],
  });
});

feature("isRunningNow", () => {
  const bucket = (ts) => ({ latestTurnTs: ts });

  unit("returns true when last event within threshold", {
    given: ["event 10s ago", () => ({ now: 100_000, b: bucket(90_000), within: 30_000 })],
    when: ["checking", ({ b, now, within }) => isRunningNow(b, now, within)],
    then: ["running", (r) => expect(r).toBe(true)],
  });

  unit("returns false when last event outside threshold", {
    given: ["event 60s ago", () => ({ now: 100_000, b: bucket(40_000), within: 30_000 })],
    when: ["checking", ({ b, now, within }) => isRunningNow(b, now, within)],
    then: ["not running", (r) => expect(r).toBe(false)],
  });

  unit("returns false when no timestamp", {
    given: ["bucket without ts", () => ({ b: bucket(null), now: 100_000 })],
    when: ["checking", ({ b, now }) => isRunningNow(b, now)],
    then: ["not running", (r) => expect(r).toBe(false)],
  });

  unit("default threshold is 30s", {
    given: ["event 25s ago", () => ({ now: 100_000, b: bucket(75_000) })],
    when: ["checking without explicit threshold", ({ b, now }) => isRunningNow(b, now)],
    then: ["running", (r) => expect(r).toBe(true)],
  });
});
