// Event ledger: the push-based state layer. Tests pin the derivation rules
// (which event wins, staleness guard) and the file-format tolerances
// (corrupt lines, rotation) that keep the hook path unbreakable.

import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import {
  appendEvent, buildEvent, latestPaneStates, mergeStatus, parseTmuxSocket, readEvents,
} from "./events.mjs";

let path;
beforeEach(() => {
  path = join(mkdtempSync(join(tmpdir(), "amux-events-")), "events.jsonl");
});

const at = (iso) => new Date(iso);

describe("buildEvent", () => {
  it("maps hook names to ledger events", () => {
    const evt = buildEvent(
      { hook_event_name: "Stop", cwd: "/w/.agents/1", session_id: "abc" },
      { session: "claw", pane: "1" },
      at("2026-07-08T10:00:00Z"),
    );
    expect(evt).toEqual({
      ts: "2026-07-08T10:00:00.000Z", event: "stop", session: "claw",
      pane: 1, cwd: "/w/.agents/1", sessionId: "abc", detail: "",
    });
  });

  it("drops unknown events and missing panes", () => {
    expect(buildEvent({ hook_event_name: "PreToolUse" }, { session: "claw", pane: 0 })).toBe(null);
    expect(buildEvent({ hook_event_name: "Stop" }, null)).toBe(null);
  });

  it("truncates notification detail to 200 chars", () => {
    const evt = buildEvent(
      { hook_event_name: "Notification", message: "x".repeat(500) },
      { session: "claw", pane: 2 },
    );
    expect(evt.detail.length).toBe(200);
  });
});

describe("parseTmuxSocket", () => {
  it("extracts the socket path from $TMUX", () => {
    expect(parseTmuxSocket("/home/u/.tmux-amux-sock,1234,0")).toBe("/home/u/.tmux-amux-sock");
    expect(parseTmuxSocket("")).toBe(null);
    expect(parseTmuxSocket(undefined)).toBe(null);
  });
});

describe("append/read roundtrip", () => {
  it("persists events and filters by since", () => {
    appendEvent({ ts: "2026-07-08T09:00:00Z", event: "stop", session: "claw", pane: 0 }, path);
    appendEvent({ ts: "2026-07-08T11:00:00Z", event: "prompt", session: "claw", pane: 0 }, path);
    expect(readEvents({ path })).toHaveLength(2);
    expect(readEvents({ path, since: "2026-07-08T10:00:00Z" })).toHaveLength(1);
  });

  it("skips corrupt lines instead of failing", () => {
    appendEvent({ ts: "2026-07-08T09:00:00Z", event: "stop", session: "claw", pane: 0 }, path);
    writeFileSync(path, readFileSync(path, "utf-8") + "{half-written garbage\n");
    appendEvent({ ts: "2026-07-08T10:00:00Z", event: "prompt", session: "claw", pane: 1 }, path);
    expect(readEvents({ path })).toHaveLength(2);
  });
});

describe("latestPaneStates", () => {
  const NOW = new Date("2026-07-08T12:00:00Z").getTime();

  it("newest event per pane wins", () => {
    appendEvent({ ts: "2026-07-08T11:00:00Z", event: "prompt", session: "claw", pane: 0 }, path);
    appendEvent({ ts: "2026-07-08T11:30:00Z", event: "stop", session: "claw", pane: 0 }, path);
    appendEvent({ ts: "2026-07-08T11:45:00Z", event: "prompt", session: "ai", pane: 3 }, path);
    const states = latestPaneStates({ path, now: NOW });
    expect(states.get("claw:0").state).toBe("idle");
    expect(states.get("ai:3").state).toBe("working");
  });

  it("notification maps to needs_you with detail", () => {
    appendEvent({ ts: "2026-07-08T11:00:00Z", event: "notification", session: "claw",
                  pane: 2, detail: "permission required" }, path);
    const states = latestPaneStates({ path, now: NOW });
    expect(states.get("claw:2")).toMatchObject({ state: "needs_you", detail: "permission required" });
  });

  it("stale events are omitted (fallback to scraping)", () => {
    appendEvent({ ts: "2026-07-08T02:00:00Z", event: "prompt", session: "claw", pane: 0 }, path);
    const states = latestPaneStates({ path, now: NOW, maxAgeMs: 6 * 3600 * 1000 });
    expect(states.has("claw:0")).toBe(false);
  });
});

describe("mergeStatus (monotone-safe merge rules)", () => {
  const NOW = new Date("2026-07-08T12:00:00Z").getTime();
  const fresh = (state) => ({ state, ts: "2026-07-08T11:55:00Z", detail: "" });
  const stale = (state) => ({ state, ts: "2026-07-08T10:00:00Z", detail: "" });

  it("scraped modal states always win over pushed", () => {
    for (const modal of ["permission", "menu", "resume", "dismiss"]) {
      expect(mergeStatus(modal, fresh("idle"), { now: NOW }))
        .toEqual({ status: modal, source: "tmux" });
    }
  });

  it("scraped working is never downgraded (auto-compact safety)", () => {
    expect(mergeStatus("working", fresh("idle"), { now: NOW }))
      .toEqual({ status: "working", source: "tmux" });
  });

  it("fresh pushed working upgrades idle/unknown (the narrow-pane fix)", () => {
    expect(mergeStatus("idle", fresh("working"), { now: NOW }))
      .toEqual({ status: "working", source: "hook" });
    expect(mergeStatus("unknown", fresh("working"), { now: NOW }))
      .toEqual({ status: "working", source: "hook" });
  });

  it("fresh pushed needs_you surfaces as permission", () => {
    expect(mergeStatus("idle", fresh("needs_you"), { now: NOW }))
      .toEqual({ status: "permission", source: "hook" });
  });

  it("stale or missing pushed state falls back to scraped", () => {
    expect(mergeStatus("idle", stale("working"), { now: NOW }))
      .toEqual({ status: "idle", source: "tmux" });
    expect(mergeStatus("unknown", null, { now: NOW }))
      .toEqual({ status: "unknown", source: "tmux" });
  });
});
