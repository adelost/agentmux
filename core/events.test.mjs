// Event ledger: the push-based state layer. Tests pin the derivation rules
// (which event wins, staleness guards, notification classification) and the
// file-format tolerances (corrupt lines, unparseable timestamps) that keep
// the hook path unbreakable.

import { feature, unit, expect } from "bdd-vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  appendEvent, buildEvent, latestPaneStates, mergeStatus, readEvents,
} from "./events.mjs";
import { detectPaneAddress } from "./sender-detect.mjs";

const freshLedger = () => join(mkdtempSync(join(tmpdir(), "amux-events-")), "events.jsonl");
const at = (iso) => new Date(iso);

feature("buildEvent", () => {
  unit("session_start records the SessionStart source", {
    given: ["a SessionStart payload with source startup", () => buildEvent(
      { hook_event_name: "SessionStart", source: "startup", cwd: "/ws/.agents/1" },
      { session: "claw", pane: 1 },
    )],
    when: ["inspecting", (e) => e],
    then: ["event carries source for the restart forensics", (e) => {
      expect(e.event).toBe("session_start");
      expect(e.source).toBe("startup");
    }],
  });

  unit("non-session events never grow a source field", {
    given: ["a Stop payload that also has a source-ish field", () => buildEvent(
      { hook_event_name: "Stop", source: "whatever" },
      { session: "claw", pane: 1 },
    )],
    when: ["inspecting", (e) => e],
    then: ["no source key", (e) => {
      expect(e.source).toBeUndefined();
    }],
  });

  unit("maps hook names to ledger events", {
    given: ["a Stop hook payload + pane", () => buildEvent(
      { hook_event_name: "Stop", cwd: "/w/.agents/1", session_id: "abc" },
      { session: "claw", pane: "1" },
      at("2026-07-08T10:00:00Z"),
    )],
    when: ["inspecting the event", (evt) => evt],
    then: ["a stop event for claw:1", (evt) => expect(evt).toEqual({
      ts: "2026-07-08T10:00:00.000Z", event: "stop", session: "claw",
      pane: 1, cwd: "/w/.agents/1", sessionId: "abc", detail: "",
    })],
  });

  unit("drops unknown events and missing panes", {
    given: ["unsupported payloads", () => [
      buildEvent({ hook_event_name: "PreToolUse" }, { session: "claw", pane: 0 }),
      buildEvent({ hook_event_name: "Stop" }, null),
    ]],
    when: ["building", (events) => events],
    then: ["both null", (events) => expect(events).toEqual([null, null])],
  });

  unit("slash commands are not turns (the /compact pin-working bug)", {
    given: ["a UserPromptSubmit for /compact", () => buildEvent(
      { hook_event_name: "UserPromptSubmit", prompt: "/compact" },
      { session: "claw", pane: 0 },
    )],
    when: ["building", (evt) => evt],
    then: ["dropped: /compact often gets no Stop and would pin working",
      (evt) => expect(evt).toBe(null)],
  });

  unit("permission notifications are flagged needsYou, idle pings are not", {
    given: ["one permission ask + one idle ping", () => ({
      perm: buildEvent(
        { hook_event_name: "Notification", message: "Claude needs your permission to use Bash" },
        { session: "claw", pane: 2 },
      ),
      idle: buildEvent(
        { hook_event_name: "Notification", message: "Claude is waiting for your input" },
        { session: "claw", pane: 2 },
      ),
    })],
    when: ["classifying", (x) => x],
    then: ["only the permission ask needs the human", ({ perm, idle }) => {
      expect(perm.needsYou).toBe(true);
      expect(idle.needsYou).toBe(false);
    }],
  });

  unit("truncates notification detail to 200 chars", {
    given: ["a 500-char message", () => buildEvent(
      { hook_event_name: "Notification", message: "x".repeat(500) },
      { session: "claw", pane: 2 },
    )],
    when: ["building", (evt) => evt],
    then: ["detail capped", (evt) => expect(evt.detail.length).toBe(200)],
  });
});

feature("detectPaneAddress", () => {
  unit("structured pane address from tmux env", {
    given: ["a tmux env + mock exec", () => detectPaneAddress(
      { TMUX: "/sock,1,0", TMUX_PANE: "%17" },
      (cmd) => (cmd.includes("#S") ? "claw\n" : "3\n"),
    )],
    when: ["resolving", (addr) => addr],
    then: ["session + pane", (addr) =>
      expect(addr).toEqual({ session: "claw", pane: 3 })],
  });
});

feature("append/read roundtrip", () => {
  unit("persists events and filters by since", {
    given: ["two events on disk", () => {
      const path = freshLedger();
      appendEvent({ ts: "2026-07-08T09:00:00Z", event: "stop", session: "claw", pane: 0 }, path);
      appendEvent({ ts: "2026-07-08T11:00:00Z", event: "prompt", session: "claw", pane: 0 }, path);
      return path;
    }],
    when: ["reading with and without since", (path) => ({
      all: readEvents({ path }),
      recent: readEvents({ path, since: "2026-07-08T10:00:00Z" }),
    })],
    then: ["2 total, 1 in window", (r) => {
      expect(r.all).toHaveLength(2);
      expect(r.recent).toHaveLength(1);
    }],
  });

  unit("skips corrupt lines instead of failing", {
    given: ["a ledger with a torn line in the middle", () => {
      const path = freshLedger();
      appendEvent({ ts: "2026-07-08T09:00:00Z", event: "stop", session: "claw", pane: 0 }, path);
      writeFileSync(path, readFileSync(path, "utf-8") + "{half-written garbage\n");
      appendEvent({ ts: "2026-07-08T10:00:00Z", event: "prompt", session: "claw", pane: 1 }, path);
      return path;
    }],
    when: ["reading", (path) => readEvents({ path })],
    then: ["both intact events survive", (events) => expect(events).toHaveLength(2)],
  });
});

feature("latestPaneStates", () => {
  const NOW = at("2026-07-08T12:00:00Z").getTime();

  unit("newest event per pane wins", {
    given: ["prompt then stop for claw:0, prompt for ai:3", () => {
      const path = freshLedger();
      appendEvent({ ts: "2026-07-08T11:00:00Z", event: "prompt", session: "claw", pane: 0 }, path);
      appendEvent({ ts: "2026-07-08T11:30:00Z", event: "stop", session: "claw", pane: 0 }, path);
      appendEvent({ ts: "2026-07-08T11:45:00Z", event: "prompt", session: "ai", pane: 3 }, path);
      return path;
    }],
    when: ["deriving states", (path) => latestPaneStates({ path, now: NOW })],
    then: ["claw:0 idle, ai:3 working", (states) => {
      expect(states.get("claw:0").state).toBe("idle");
      expect(states.get("ai:3").state).toBe("working");
    }],
  });

  unit("permission notification maps to needs_you; idle ping carries no state", {
    given: ["one of each notification kind", () => {
      const path = freshLedger();
      appendEvent({ ts: "2026-07-08T11:00:00Z", event: "notification", session: "claw",
                    pane: 2, detail: "permission required", needsYou: true }, path);
      appendEvent({ ts: "2026-07-08T11:00:00Z", event: "notification", session: "claw",
                    pane: 4, detail: "waiting for your input", needsYou: false }, path);
      return path;
    }],
    when: ["deriving states", (path) => latestPaneStates({ path, now: NOW })],
    then: ["pane 2 needs_you, pane 4 absent", (states) => {
      expect(states.get("claw:2")).toMatchObject({ state: "needs_you", detail: "permission required" });
      expect(states.has("claw:4")).toBe(false);
    }],
  });

  unit("stale and unparseable-ts events are omitted (fallback to scraping)", {
    given: ["an old event and a ts-less event", () => {
      const path = freshLedger();
      appendEvent({ ts: "2026-07-08T02:00:00Z", event: "prompt", session: "claw", pane: 0 }, path);
      appendEvent({ event: "prompt", session: "claw", pane: 5 }, path);
      return path;
    }],
    when: ["deriving states", (path) =>
      latestPaneStates({ path, now: NOW, maxAgeMs: 6 * 3600 * 1000 })],
    then: ["neither pane is pinned", (states) => {
      expect(states.has("claw:0")).toBe(false);
      expect(states.has("claw:5")).toBe(false);
    }],
  });
});

feature("mergeStatus (allowlist merge rules)", () => {
  const NOW = at("2026-07-08T12:00:00Z").getTime();
  const pushedAt = (state, iso) => ({ state, ts: iso, detail: "" });

  unit("only idle/unknown may be refined: every other scrape wins", {
    given: ["live scraped observations", () =>
      ["permission", "menu", "resume", "dismiss", "working", "somefuturemodal"]],
    when: ["merging each against a fresh pushed idle", (scrapes) =>
      scrapes.map((s) => mergeStatus(s, pushedAt("idle", "2026-07-08T11:59:00Z"), { now: NOW }))],
    then: ["all come back scraped-from-tmux", (results) =>
      results.forEach((r) => expect(r.source).toBe("tmux"))],
  });

  unit("fresh pushed working upgrades idle/unknown (the narrow-pane fix)", {
    given: ["a 2-minute-old prompt event", () => pushedAt("working", "2026-07-08T11:58:00Z")],
    when: ["merging over idle and unknown", (pushed) => [
      mergeStatus("idle", pushed, { now: NOW }),
      mergeStatus("unknown", pushed, { now: NOW }),
    ]],
    then: ["both report working from hook", (results) =>
      results.forEach((r) => expect(r).toEqual({ status: "working", source: "hook" }))],
  });

  unit("pushed working expires fast (Esc/crash never fire Stop)", {
    given: ["a 6-minute-old prompt event", () => pushedAt("working", "2026-07-08T11:54:00Z")],
    when: ["merging over idle", (pushed) => mergeStatus("idle", pushed, { now: NOW })],
    then: ["scrape wins: bounded lie, not a 15-min hang for amux wait", (r) =>
      expect(r).toEqual({ status: "idle", source: "tmux" })],
  });

  unit("fresh pushed needs_you surfaces as permission", {
    given: ["a 10-minute-old permission notification", () => pushedAt("needs_you", "2026-07-08T11:50:00Z")],
    when: ["merging over idle", (pushed) => mergeStatus("idle", pushed, { now: NOW })],
    then: ["permission from hook", (r) =>
      expect(r).toEqual({ status: "permission", source: "hook" })],
  });

  unit("stale, missing or ts-less pushed state falls back to scraped", {
    given: ["three degenerate pushed states", () => [
      pushedAt("idle", "2026-07-08T10:00:00Z"),   // stale
      null,                                        // missing
      pushedAt("working", undefined),              // unparseable ts
    ]],
    when: ["merging each over unknown", (cases) =>
      cases.map((p) => mergeStatus("unknown", p, { now: NOW }))],
    then: ["always the scrape", (results) =>
      results.forEach((r) => expect(r).toEqual({ status: "unknown", source: "tmux" }))],
  });
});
