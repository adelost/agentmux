import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  collectContextTelemetry,
  contextTelemetrySnapshot,
  emptyContextPushState,
  nativeContextReading,
  parseFleetProjects,
  reconcileContextTelemetry,
} from "../core/suggestions-context-telemetry.mjs";
import {
  loadContextPushConfig,
  pushContextOnce,
  readCompactEvents,
} from "../bin/suggestions-context-push.mjs";

const projectBySession = { lsrc: "source" };
const reading = (overrides = {}) => ({
  agentId: "lsrc:3",
  session: "lsrc",
  pane: 3,
  engine: "codex",
  model: "gpt-5.6-sol",
  effort: "max",
  percent: 73,
  usedTokens: 189_000,
  windowTokens: 258_904,
  observedAt: "2026-07-15T12:00:00.000Z",
  source: "codex-jsonl",
  confidence: "exact",
  lastCompactAt: null,
  ...overrides,
});

describe("context telemetry reconciliation", () => {
  it("projects canonical rows and native compact events without quota fields", async () => {
    const compactAt = "2026-07-15T12:01:00.000Z";
    const context = nativeContextReading({ agent: {
      context: { percent: 18, usedTokens: 46_600, windowTokens: 258_904 },
      model: "gpt-5.6-sol", effort: "max", updatedAt: "2026-07-15T12:01:02.000Z",
    }, events: [{ type: "web", subtype: "compacted", at: compactAt }] });
    expect(context).toMatchObject({ percent: 18, tokens: 46_600, windowTokens: 258_904,
      source: "native-runtime", confidence: "exact", lastCompactAt: compactAt });

    const rows = await collectContextTelemetry({}, {
      agents: [{ name: "lsrc", panes: [{ label: "owner" }] }],
      hasSession: async () => true,
      listPanes: async () => [{ index: 0 }],
      dialectFor: () => "codex",
      inspectPane: async () => ({ status: "working", preview: "busy", context }),
    });
    const snapshot = contextTelemetrySnapshot(rows, "2026-07-15T12:01:03.000Z");
    expect(snapshot.agents).toEqual([expect.objectContaining({
      agentId: "lsrc:0", session: "lsrc", engine: "codex", model: "gpt-5.6-sol",
      percent: 18, usedTokens: 46_600, lastCompactAt: compactAt,
    })]);
    expect(snapshot).not.toHaveProperty("claude");
    expect(snapshot).not.toHaveProperty("codex");
  });

  it("maps only fleet rows that name a Suggestions project", () => {
    expect(parseFleetProjects([
      "# session broker repos project",
      "lsrc 2 /repo/a,/repo/b source",
      "api 2 /repo/api",
      "watch 2 /repo/watch skyvw # inline comment",
    ].join("\n"))).toEqual({ lsrc: "source", watch: "skyvw" });
  });

  it("emits a canonical first sample, then only changes or bounded heartbeats", () => {
    const first = reconcileContextTelemetry({
      state: emptyContextPushState(),
      snapshot: { agents: [reading()] },
      projectBySession,
      mutationId: "first",
      nowMs: Date.parse("2026-07-15T12:00:01Z"),
    });
    expect(first.payload.samples).toEqual([expect.objectContaining({
      projectId: "source",
      agentId: "lsrc:3",
      model: "gpt-5.6-sol",
      effort: "max",
      percent: 73,
      usedTokens: 189_000,
      sessionGeneration: 1,
      sampleSeq: 1,
    })]);

    const quiet = reconcileContextTelemetry({
      state: first.state,
      snapshot: { agents: [reading({ observedAt: "2026-07-15T12:01:00Z" })] },
      projectBySession,
      mutationId: "quiet",
      nowMs: Date.parse("2026-07-15T12:01:00Z"),
    });
    expect(quiet.payload).toBeNull();

    const heartbeat = reconcileContextTelemetry({
      state: quiet.state,
      snapshot: { agents: [reading({ observedAt: "2026-07-15T12:05:02Z" })] },
      projectBySession,
      mutationId: "heartbeat",
      nowMs: Date.parse("2026-07-15T12:05:02Z"),
    });
    expect(heartbeat.payload.samples[0]).toMatchObject({ sessionGeneration: 1, sampleSeq: 2 });
  });

  it("advances generation on explicit compact and rejects a delayed pre-compact sample", () => {
    const first = reconcileContextTelemetry({
      state: emptyContextPushState(),
      snapshot: { agents: [reading()] },
      projectBySession,
      mutationId: "before",
      nowMs: Date.parse("2026-07-15T12:00:01Z"),
    });
    const compacted = reconcileContextTelemetry({
      state: first.state,
      snapshot: { agents: [reading({ observedAt: "2026-07-15T12:00:10Z" })] },
      compactEvents: [{ agentId: "lsrc:3", at: "2026-07-15T12:01:00Z" }],
      projectBySession,
      mutationId: "compact",
      nowMs: Date.parse("2026-07-15T12:01:01Z"),
    });
    expect(compacted.payload.compacts).toEqual([expect.objectContaining({
      sessionGeneration: 2,
      before: expect.objectContaining({ percent: 73, sampleSeq: 1 }),
    })]);
    expect(compacted.payload.samples).toEqual([]);

    const after = reconcileContextTelemetry({
      state: compacted.state,
      snapshot: { agents: [reading({
        percent: 18,
        usedTokens: 46_600,
        observedAt: "2026-07-15T12:01:02Z",
      })] },
      projectBySession,
      mutationId: "after",
      nowMs: Date.parse("2026-07-15T12:01:03Z"),
    });
    expect(after.payload.samples[0]).toMatchObject({
      percent: 18,
      sessionGeneration: 2,
      sampleSeq: 1,
    });
  });

  it("deduplicates the same compact reported by both engine history and the hook ledger", () => {
    const result = reconcileContextTelemetry({
      state: emptyContextPushState(),
      snapshot: { agents: [reading({ lastCompactAt: "2026-07-15T12:01:00Z" })] },
      compactEvents: [{ agentId: "lsrc:3", at: "2026-07-15T12:01:00Z" }],
      projectBySession,
      mutationId: "same-compact",
      nowMs: Date.parse("2026-07-15T12:01:01Z"),
    });
    expect(result.payload.compacts).toHaveLength(1);
  });
});

describe("context push durability", () => {
  it("keeps incomplete ledger lines behind the cursor", () => {
    const root = mkdtempSync(join(tmpdir(), "amux-context-ledger-"));
    const path = join(root, "events.jsonl");
    const complete = JSON.stringify({
      ts: "2026-07-15T12:01:00Z", event: "session_start", source: "compact", session: "lsrc", pane: 3,
    });
    writeFileSync(path, `${complete}\n{"partial":`);
    const result = readCompactEvents(path, 0);
    expect(result.events).toEqual([{ agentId: "lsrc:3", at: "2026-07-15T12:01:00.000Z" }]);
    expect(result.cursor).toBe(Buffer.byteLength(`${complete}\n`));
    rmSync(root, { recursive: true, force: true });
  });

  it("replays the exact pending mutation after a lost response before collecting again", async () => {
    const root = mkdtempSync(join(tmpdir(), "amux-context-push-"));
    const config = {
      baseUrl: "https://suggest.test",
      credentialFile: join(root, "token"),
      fleetConfigFile: join(root, "fleets.conf"),
      eventsFile: join(root, "events.jsonl"),
      stateFile: join(root, "state.json"),
      heartbeatMs: 300_000,
    };
    writeFileSync(config.fleetConfigFile, "lsrc 2 /repo source\n");
    writeFileSync(config.eventsFile, "");
    const fetchImpl = vi.fn()
      .mockRejectedValueOnce(new Error("response lost"))
      .mockResolvedValue({ status: 200, json: async () => ({ replay: true }) });
    const readTop = vi.fn(async () => ({ version: 1, agents: [reading()] }));

    await expect(pushContextOnce({
      config, token: "secret", fetchImpl, readTop, uuid: () => "stable", now: () => Date.parse("2026-07-15T12:00:01Z"),
    })).rejects.toThrow("response lost");
    const pendingBody = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(JSON.parse(readFileSync(config.stateFile, "utf-8")).pending.payload).toEqual(pendingBody);

    await pushContextOnce({
      config, token: "secret", fetchImpl, readTop, uuid: () => "next", now: () => Date.parse("2026-07-15T12:00:02Z"),
    });
    expect(JSON.parse(fetchImpl.mock.calls[1][1].body)).toEqual(pendingBody);
    expect(readTop).toHaveBeenCalledTimes(2);
    expect(JSON.parse(readFileSync(config.stateFile, "utf-8")).pending).toBeNull();
    rmSync(root, { recursive: true, force: true });
  });

  it("shares the quota credential config while validating context-specific cadence", () => {
    const config = loadContextPushConfig([
      "baseUrl: https://suggest.v1d.io/",
      "adminCredentialFile: ~/.config/agent/suggestions-admin-token",
      "contextHeartbeatMs: 120000",
    ].join("\n"));
    expect(config.baseUrl).toBe("https://suggest.v1d.io");
    expect(config.heartbeatMs).toBe(120_000);
    expect(() => loadContextPushConfig([
      "baseUrl: https://suggest.v1d.io",
      "adminCredentialFile: /token",
      "contextHeartbeatMs: 1000",
    ].join("\n"))).toThrow("between 60000 and 3600000");
  });
});
