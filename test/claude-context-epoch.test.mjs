import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { appendFileSync, mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { getContextFromPane, getContextPercent, getContextPushed } from "../core/context.mjs";
import { claudeProjectDir } from "../core/claude-paths.mjs";
import { createAutoCompact } from "../channels/auto-compact.mjs";
import { DEFAULT_CONFIG } from "../core/auto-compact.mjs";

vi.mock("../cli/send-notify.mjs", () => ({
  notifyUser: vi.fn(), setChannelTopicThrottled: vi.fn(async () => ({ updated: true })),
}));

const NOW = Date.parse("2026-09-06T05:55:00Z");
const COMPACT = "2026-09-05T03:47:04.654Z";
const FOOTER = "  ⬆ /gsd-update │ Fable 5.1 │ 1 ░░░░░░░░░░ 0% · thinking: xhigh";
const SCREEN = `old messages\n❯ /compact\n  ⎿ Not enough messages to compact.\n────\n❯ \n────\n${FOOTER}\n bypass permissions on`;

describe("Claude context belongs to the current compact epoch", () => {
  let home, paneDir, journal, sessionId, bridge, oldHome;
  const append = (event) => appendFileSync(journal, `${JSON.stringify(event)}\n`);
  const usage = (tokens, timestamp = "2026-09-04T09:31:19.530Z", id = sessionId) => ({
    type: "assistant", sessionId: id, timestamp,
    message: { model: "claude-fable-5-1", usage: { input_tokens: tokens } },
  });
  const compact = (timestamp = COMPACT) => append({ type: "system", subtype: "compact_boundary", sessionId, timestamp });
  const poller = (initial = SCREEN) => {
    const state = { content: initial };
    const yaml = join(home, "agents.yaml");
    writeFileSync(yaml, `test:\n  dir: ${home}\n  discord: "offline-channel"\n  panes:\n    - name: claude\n      cmd: claude\n`);
    const enqueueAndWait = vi.fn(async () => ({ delivered: true }));
    const send = vi.fn(), log = vi.fn();
    const ac = createAutoCompact({ agentsYamlPath: yaml, agent: { capturePane: async () => state.content },
      deliveryBroker: { enqueueAndWait }, tmux: async () => ({ stdout: "0 30" }),
      config: DEFAULT_CONFIG, discord: { send }, log });
    return { ac, state, enqueueAndWait, send, log };
  };
  const humanTurn = () => append({ type: "user", timestamp: "2026-09-06T05:30:00Z",
    message: { role: "user", content: "Work on this feature" } });
  beforeEach(() => {
    vi.useFakeTimers(); vi.setSystemTime(NOW);
    oldHome = process.env.HOME;
    home = mkdtempSync(join(tmpdir(), "amux-claude-epoch-"));
    process.env.HOME = home;
    paneDir = join(home, ".agents", "0");
    sessionId = randomUUID();
    const project = claudeProjectDir(paneDir);
    mkdirSync(project, { recursive: true });
    journal = join(project, `${sessionId}.jsonl`);
    bridge = join(tmpdir(), `claude-ctx-${sessionId}.json`);
    writeFileSync(journal, "");
    append(usage(602_000));
  });
  afterEach(() => {
    if (oldHome === undefined) delete process.env.HOME; else process.env.HOME = oldHome;
    rmSync(home, { recursive: true, force: true }); rmSync(bridge, { force: true });
    vi.useRealTimers();
  });

  it("does not recycle usage before a compact into an invented current value", () => {
    expect(getContextPercent(paneDir, "claude")?.tokens).toBe(602_000);
    compact();
    expect(getContextPercent(paneDir, "claude")).toBeNull();
    expect(getContextFromPane(SCREEN, paneDir)).toMatchObject({ percent: 0, tokens: null, source: "claude-live-statusline" });
  });

  it("uses actual post-compact usage, not synthetic no-op usage", () => {
    compact();
    append(usage(24_000, "2026-09-06T05:40:00Z"));
    append({ type: "assistant", message: { model: "<synthetic>", usage: { input_tokens: 0 } } });
    expect(getContextPercent(paneDir, "claude")).toMatchObject({ tokens: 24_000, percent: 2, sessionId });
  });

  it("does not fabricate an observation timestamp from file mtime", () => {
    writeFileSync(journal, ""); append({ ...usage(602_000), timestamp: undefined });
    expect(getContextPercent(paneDir, "claude")?.observedAt).toBeNull();
  });

  it("rejects preserved old usage even if appended after the boundary", () => {
    compact(); append(usage(602_000));
    expect(getContextPercent(paneDir, "claude")).toBeNull();
  });

  it("never uses a different session's usage", () => {
    writeFileSync(journal, ""); append(usage(900_000, "2026-09-06T05:45:00Z", randomUUID()));
    expect(getContextPercent(paneDir, "claude")).toBeNull();
  });

  it.each(["pre-compact", "wrong-session", "null-percent", "future"])("rejects %s pushed context", (kind) => {
    compact("2026-09-06T05:30:00Z");
    writeFileSync(bridge, JSON.stringify({ session_id: kind === "wrong-session" ? randomUUID() : sessionId,
      used_pct: kind === "null-percent" ? null : 92,
      timestamp: (kind === "pre-compact" ? Date.parse("2026-09-06T05:20:00Z") : NOW + (kind === "future" ? 60_000 : 0)) / 1000 }));
    expect(getContextPushed(paneDir)).toBeNull();
    expect(getContextPercent(paneDir, "claude")).toBeNull();
  });

  it("accepts a matching post-compact push without borrowing old tokens", () => {
    compact();
    writeFileSync(bridge, JSON.stringify({ session_id: sessionId, used_pct: 0, timestamp: NOW / 1000 }));
    expect(getContextPushed(paneDir)).toMatchObject({ percent: 0, tokens: null, sessionId });
  });

  it("prefers the current footer over a conflicting cache and ignores a past footer", () => {
    writeFileSync(bridge, JSON.stringify({ session_id: sessionId, used_pct: 92, timestamp: NOW / 1000 }));
    expect(getContextFromPane(SCREEN, paneDir)?.percent).toBe(0);
    rmSync(bridge); compact();
    expect(getContextFromPane(`${FOOTER}\n❯ unrelated text`, paneDir)).toBeNull();
  });

  it("the real poll loop neither warns nor enqueues on the Skyvw1 stale-usage/no-op fixture", async () => {
    compact();
    append({ type: "user", timestamp: "2026-09-06T03:02:15Z", message: { role: "user", content: "/compact" } });
    append({ type: "system", timestamp: "2026-09-06T03:02:16.555Z", content: "Not enough messages to compact." });
    const { ac, enqueueAndWait, send } = poller();
    await ac.tick(); vi.setSystemTime(NOW + 60_000); await ac.tick();
    expect(Object.keys(ac.getWarnings())).toHaveLength(0);
    expect(enqueueAndWait).not.toHaveBeenCalled();
    expect(send).not.toHaveBeenCalled();
  });

  it("cancels an old warning when compact makes context unknown", async () => {
    humanTurn(); append(usage(602_000, "2026-09-06T05:31:00Z"));
    const { ac, enqueueAndWait } = poller("❯ ");
    await ac.tick();
    expect(Object.keys(ac.getWarnings())).toHaveLength(1);
    compact("2026-09-06T05:54:59Z");
    vi.setSystemTime(NOW + 60_000); await ac.tick();
    expect(Object.keys(ac.getWarnings())).toHaveLength(0);
    expect(enqueueAndWait).not.toHaveBeenCalled();
  });

  it("does not transfer a previous session's warning grace to a replacement session", async () => {
    humanTurn(); append(usage(602_000, "2026-09-06T05:31:00Z"));
    const { ac, enqueueAndWait } = poller("❯ ");
    await ac.tick(); expect(Object.keys(ac.getWarnings())).toHaveLength(1);
    sessionId = randomUUID(); journal = join(claudeProjectDir(paneDir), `${sessionId}.jsonl`);
    writeFileSync(journal, ""); humanTurn(); append(usage(702_000, "2026-09-06T05:31:00Z"));
    // A new journal becomes the resolver's current session; no active engine is restarted.
    utimesSync(journal, new Date("2030-01-01"), new Date("2030-01-01"));
    vi.setSystemTime(NOW + 60_000); await ac.tick();
    expect(ac.getWarnings()["test:0"]).toMatchObject({ warned_at: NOW + 60_000, sessionId });
    expect(enqueueAndWait).not.toHaveBeenCalled();
  });

  it("a delivered Claude slash is a request, never a successful compact notice", async () => {
    humanTurn(); append(usage(602_000, "2026-09-06T05:31:00Z"));
    const { ac, enqueueAndWait, send, log } = poller("❯ ");
    await ac.tick(); vi.setSystemTime(NOW + 60_000); await ac.tick();
    expect(enqueueAndWait).toHaveBeenCalledTimes(1);
    expect(enqueueAndWait.mock.calls[0][0]).toMatchObject({ text: "/compact", source: "auto-compact" });
    expect(send.mock.calls.map(([, text]) => text).join("\n")).not.toMatch(/Auto-compacting|compacted/iu);
    expect(log.mock.calls.flat().join("\n")).toContain("requested /compact");
    vi.setSystemTime(NOW + 240_000); await ac.tick();
    expect(enqueueAndWait).toHaveBeenCalledTimes(1);
  });
});
