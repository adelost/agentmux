import { describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { readAllTurnsAcrossPanes } from "./jsonl-reader.mjs";
import {
  formatWatchdogFallbackView,
  watchdogFallbackView,
} from "./suggestions-watchdog-fallback.mjs";
import {
  assignmentDeliveryAvailability,
  assignmentDeliveryEligibility,
  createAmuxOutboxDeliverer,
  loadPrivateCredential,
  loadWatchdogOutboxConfig,
  pollWatchdogOutboxes,
  watchdogDeliveryKey,
} from "./suggestions-watchdog-outbox.mjs";

const READ = "r".repeat(40);
const ADMIN = "a".repeat(40);
const PROMPT = "BROKER CHECK — SRC-0025 — immutable\ncontinue(next checkpoint/recheck)";
const PUBLIC_PROJECTS = Object.freeze(["skydive", "skyvw", "ai", "source"]);
const PROJECT_BROKERS = Object.freeze({
  source: "lsrc:2",
  skydive: "skydive:2",
  skyvw: "watch:2",
  ai: "ai:2",
});

const alert = Object.freeze({
  id: 7,
  ticketId: "SRC-0025",
  assignmentId: 6,
  kind: "broker_check_due",
  dedupeKey: "broker-check:SRC-0025:1:6:1",
  payload: Object.freeze({ resolvedPrompt: PROMPT }),
  queuedAt: 1_000,
  deliveredAt: null,
});

const assignmentAlert = Object.freeze({
  id: 8,
  ticketId: "SRC-0026",
  assignmentId: 9,
  kind: "assignment_offer_delivery",
  dedupeKey: "assignment-offer:9:1",
  payload: Object.freeze({
    targetAgent: "lsrc:4",
    offerPrompt: "ASSIGNMENT OFFER — SRC-0026 — owner lsrc:4",
  }),
  queuedAt: 2_000,
  deliveredAt: null,
});

function api({ ackStatus = 200, registryProjects = PUBLIC_PROJECTS,
  outboxAlert = alert, outboxAlerts = null, watchdogPolicy = null } = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : null });
    if (url.pathname === "/api/config") return Response.json({
      project: { id: url.searchParams.get("project"),
        routingGuide: { workers: [{ role: "broker",
          id: PROJECT_BROKERS[url.searchParams.get("project")] }] } },
      projects: registryProjects.map((id) => ({ id })),
      assignmentBootstrap: { project: { id: url.searchParams.get("project"),
        brokerOwner: PROJECT_BROKERS[url.searchParams.get("project")] } },
      assignmentDelivery: { version: "assignment-delivery.v1", idleMs: 600_000,
        requireExplicitDoneOrSustainedIdle: true, unknownPresence: "deny" },
      ...(watchdogPolicy ? { watchdogPolicy } : {}),
    });
    if (url.pathname === "/api/config/agentdocs") return Response.json({
      project: {
        id: url.searchParams.get("project"),
        routingGuide: { workers: [{ role: "broker",
          id: PROJECT_BROKERS[url.searchParams.get("project")] }] },
      },
      assignmentDelivery: { version: "assignment-delivery.v1", idleMs: 600_000,
        requireExplicitDoneOrSustainedIdle: true, unknownPresence: "deny" },
    });
    if (url.pathname === "/api/watchdog/outbox") {
      return Response.json({ alerts: outboxAlerts ?? [outboxAlert] });
    }
    if (url.pathname === "/api/watchdog/outbox/ack") {
      const requestedId = init.body ? JSON.parse(String(init.body)).id : null;
      return Response.json(ackStatus === 200 ? { acknowledged: true, id: requestedId }
        : { error: "ack-failed" }, { status: ackStatus });
    }
    return Response.json({ error: "not-found" }, { status: 404 });
  });
  return { calls, fetchImpl };
}

const config = (projects = ["source"]) => ({
  baseUrl: "https://suggest.v1d.io",
  projects,
  discoveryProject: "source",
  requestTimeoutMs: 1_000,
});

describe("persistent Suggestions watchdog outbox consumer", () => {
  it("requires explicit done or ten minutes of sustained idle", () => {
    const now = 1_000_000;
    expect(assignmentDeliveryEligibility({ paneStatus: "working", now,
      lastAssistantAt: now - 60_000, lastAssistantText: "klart" }))
      .toMatchObject({ eligible: false, reason: "pane-working" });
    expect(assignmentDeliveryEligibility({ paneStatus: "idle", now,
      lastUserAt: now - 30_000, lastAssistantAt: now - 60_000,
      lastAssistantText: "klart" })).toMatchObject({ eligible: false });
    expect(assignmentDeliveryEligibility({ paneStatus: "idle", now,
      lastUserAt: now - 60_000, lastAssistantAt: now - 30_000,
      lastAssistantText: "Fixat, mergat och deployat." }))
      .toMatchObject({ eligible: true, reason: "explicit-done" });
    expect(assignmentDeliveryEligibility({ paneStatus: "idle", now,
      lastUserAt: now - 600_001, lastAssistantText: "jobbar vidare" }))
      .toMatchObject({ eligible: true, reason: "sustained-idle" });
    expect(assignmentDeliveryEligibility({ paneStatus: "idle", now,
      lastUserAt: now - 599_999, lastAssistantText: "jobbar vidare" }))
      .toMatchObject({ eligible: false, reason: "idle-threshold-not-met" });
    expect(assignmentDeliveryEligibility({ paneStatus: "idle", now,
      lastCoordinationAt: now - 30_000, lastAssistantAt: now - 20 * 60_000,
      lastAssistantText: "Klart." }))
      .toMatchObject({ eligible: false, reason: "recent-inter-agent-contact" });
    expect(assignmentDeliveryEligibility({ paneStatus: "idle", now,
      lastCoordinationAt: now - 30_000, lastAssistantAt: now - 1,
      lastAssistantText: "Jag är idle och tillgänglig.\nASSIGNMENT_AVAILABLE" }))
      .toMatchObject({ eligible: true, reason: "explicit-available" });

    expect(assignmentDeliveryAvailability({ paneStatus: "idle", now,
      agent: "lsrc", pane: 6, rows: [] }))
      .toEqual({ eligible: false, reason: "no-turn-data", idleForMs: null });

    const presenceNow = 5_000_000;
    expect(assignmentDeliveryAvailability({ paneStatus: "idle", now: presenceNow,
      agent: "lsrc", pane: 6, rows: [
        { agent: "lsrc", pane: 6, role: "assistant", type: "text",
          timestamp: new Date(presenceNow - 45 * 60_000).toISOString(), content: "jobbar vidare" },
        { agent: "lsrc", pane: 6, role: "user", type: "text",
          timestamp: new Date(presenceNow - 60_000).toISOString(),
          content: "[from lsrc:2]\n\nBroker follow-up that must not reset owner availability." },
      ] }))
      .toMatchObject({ eligible: false, reason: "recent-inter-agent-contact", idleForMs: 60_000 });

    expect(assignmentDeliveryAvailability({ paneStatus: "idle", now: presenceNow,
      agent: "lsrc", pane: 6, rows: [
        { agent: "lsrc", pane: 6, role: "assistant", type: "text",
          timestamp: new Date(presenceNow - 45 * 60_000).toISOString(), content: "jobbar vidare" },
        { agent: "lsrc", pane: 6, role: "user", type: "text",
          timestamp: new Date(presenceNow - 60_000).toISOString(),
          content: "ASSIGNMENT OFFER — SRC-0117 — generation 1\nOwner: lsrc:6" },
        { agent: "lsrc", pane: 6, role: "assistant", type: "text",
          timestamp: new Date(presenceNow - 30_000).toISOString(),
          content: "Offret saknar fortfarande receipt; jag gör inget annat i turen." },
      ] }))
      .toMatchObject({ eligible: true, reason: "sustained-idle", idleForMs: 45 * 60_000 });

    expect(assignmentDeliveryAvailability({ paneStatus: "idle", now: presenceNow,
      agent: "lsrc", pane: 6, rows: [
        { agent: "lsrc", pane: 6, role: "user", type: "text",
          timestamp: new Date(presenceNow - 60_000).toISOString(),
          content: "ASSIGNMENT OFFER — SRC-0117 — generation 1\nOwner: lsrc:6" },
        { agent: "lsrc", pane: 6, role: "assistant", type: "text",
          timestamp: new Date(presenceNow - 30_000).toISOString(),
          content: "Offret är olevererat; jag är idle.\nASSIGNMENT_AVAILABLE" },
      ] }))
      .toMatchObject({ eligible: true, reason: "explicit-available", idleForMs: 30_000 });

    expect(assignmentDeliveryAvailability({ paneStatus: "idle", now: presenceNow,
      agent: "lsrc", pane: 6, rows: [
        { agent: "lsrc", pane: 6, role: "assistant", type: "text",
          timestamp: new Date(presenceNow - 45 * 60_000).toISOString(), content: "jobbar vidare" },
        { agent: "lsrc", pane: 6, role: "user", type: "text",
          timestamp: new Date(presenceNow - 60_000).toISOString(),
          content: "ASSIGNMENT OFFER — SRC-0117 — generation 1\nOwner: lsrc:6" },
        { agent: "lsrc", pane: 6, role: "assistant", type: "tool",
          timestamp: new Date(presenceNow - 45_000).toISOString(), content: "exec tests" },
      ] }))
      .toMatchObject({ eligible: false, reason: "idle-threshold-not-met", idleForMs: 45_000 });
  });

  it("keeps a busy assignment offer pending and routes an eligible offer to its owner", async () => {
    const remote = api({ outboxAlert: assignmentAlert });
    const deliver = vi.fn(async () => ({
      jobId: "9".repeat(32), status: "acknowledged", acknowledgedAt: 2_100,
    }));
    const logger = { info: vi.fn(), error: vi.fn() };
    const onAssignmentUnavailable = vi.fn(async () => ({ sent: true }));

    await expect(pollWatchdogOutboxes({
      config: config(), readToken: READ, adminToken: ADMIN,
      fetchImpl: remote.fetchImpl, deliver,
      now: () => assignmentAlert.queuedAt + 5 * 60_000,
      availability: async ({ idleMs }) => ({ eligible: false,
        reason: idleMs === 600_000 ? "pane-working" : "wrong-policy" }),
      onAssignmentUnavailable,
      logger,
    })).rejects.toThrow(/1 pending alert/u);
    expect(deliver).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledWith(expect.stringMatching(
      /assignment offer was not attempted \(pane-working; ownerAckClockStarted=false\)/u));
    expect(onAssignmentUnavailable).not.toHaveBeenCalled();

    await expect(pollWatchdogOutboxes({
      config: config(), readToken: READ, adminToken: ADMIN,
      fetchImpl: remote.fetchImpl, deliver,
      now: () => assignmentAlert.queuedAt + 10 * 60_000,
      availability: async () => ({ eligible: false, reason: "pane-working" }),
      onAssignmentUnavailable,
      logger,
    })).rejects.toThrow(/1 pending alert/u);
    expect(onAssignmentUnavailable).toHaveBeenCalledWith(expect.objectContaining({
      alarmReason: "assignment-offer-never-attempted:pane-working",
      ownerAckClockStarted: false,
    }));
    expect(remote.calls.filter((call) => call.url.pathname.endsWith("/ack"))).toHaveLength(0);

    await expect(pollWatchdogOutboxes({
      config: config(), readToken: READ, adminToken: ADMIN,
      fetchImpl: remote.fetchImpl, deliver,
      availability: async ({ idleMs }) => ({ eligible: idleMs === 600_000,
        reason: "explicit-done" }),
    })).resolves.toMatchObject({ delivered: 1, pending: 0 });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      agent: "lsrc", pane: 4, prompt: assignmentAlert.payload.offerPrompt,
    }));
  });

  it("delivers at sustained idle before the receipt SLA instead of aging to fallback", async () => {
    const remote = api({ outboxAlert: assignmentAlert });
    const deliver = vi.fn(async () => ({
      jobId: "8".repeat(32), status: "acknowledged", acknowledgedAt: 602_001,
    }));
    const onAssignmentUnavailable = vi.fn();
    const rows = [{ agent: "lsrc", pane: 4, role: "assistant", type: "text",
      timestamp: new Date(2_001).toISOString(), content: "Jag arbetar fortfarande." }];
    let clock = assignmentAlert.queuedAt + 5 * 60_000;
    const availability = async ({ agent, pane, idleMs }) => assignmentDeliveryAvailability({
      paneStatus: "idle", rows, agent, pane, idleMs, now: clock,
    });

    await expect(pollWatchdogOutboxes({
      config: config(), readToken: READ, adminToken: ADMIN,
      fetchImpl: remote.fetchImpl, deliver, availability,
      onAssignmentUnavailable, now: () => clock,
    })).rejects.toThrow(/1 pending alert/u);
    expect(deliver).not.toHaveBeenCalled();
    expect(onAssignmentUnavailable).not.toHaveBeenCalled();

    clock = 2_001 + 10 * 60_000;
    await expect(pollWatchdogOutboxes({
      config: config(), readToken: READ, adminToken: ADMIN,
      fetchImpl: remote.fetchImpl, deliver, availability,
      onAssignmentUnavailable, now: () => clock,
    })).resolves.toMatchObject({ delivered: 1, pending: 0 });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(onAssignmentUnavailable).not.toHaveBeenCalled();
  });

  it("runs eligibility against the bounded Codex timeline instead of an idle fixture", () => {
    const fakeHome = mkdtempSync(join(tmpdir(), "amux-src0114-real-path-"));
    const originalHome = process.env.HOME;
    const agentDir = join(fakeHome, "lsrc");
    const paneDir = join(agentDir, ".agents", "6");
    const sessionDir = join(fakeHome, ".codex", "sessions", "2026", "07", "17");
    const now = Date.parse("2026-07-17T12:00:00Z");
    try {
      process.env.HOME = fakeHome;
      mkdirSync(paneDir, { recursive: true });
      mkdirSync(sessionDir, { recursive: true });
      writeFileSync(join(sessionDir, "rollout-src0114.jsonl"), [
        { type: "session_meta", payload: { cwd: paneDir } },
        { type: "event_msg", timestamp: "2026-07-17T10:00:00Z",
          payload: { type: "task_started", turn_id: "SRC-0114" } },
        { type: "event_msg", timestamp: "2026-07-17T10:00:01Z",
          payload: { type: "user_message", message: "long active turn" } },
        { type: "response_item", timestamp: "2026-07-17T10:30:00Z",
          payload: { type: "custom_tool_call_output", output: "x".repeat(16_000) } },
        { type: "response_item", timestamp: "2026-07-17T11:15:00Z", payload: {
          type: "message", role: "assistant",
          content: [{ type: "output_text", text: "work paused while the prompt remains outside the tail" }],
        } },
        { type: "event_msg", timestamp: "2026-07-17T11:15:01Z",
          payload: { type: "task_complete", turn_id: "SRC-0114" } },
      ].map((event) => JSON.stringify(event)).join("\n") + "\n");
      const panes = Array.from({ length: 7 }, () => ({ cmd: "bash" }));
      panes[6] = { cmd: "codex --yolo" };
      const rows = readAllTurnsAcrossPanes({ agents: [{ name: "lsrc", dir: agentDir, panes }],
        agent: "lsrc", pane: 6, limit: 200, tailBytes: 2 * 1024 });
      expect(rows.length).toBeGreaterThan(0);
      expect(assignmentDeliveryAvailability({ paneStatus: "idle", rows,
        agent: "lsrc", pane: 6, now, idleMs: 600_000 }))
        .toMatchObject({ eligible: true, reason: "sustained-idle" });
    } finally {
      process.env.HOME = originalHome;
      rmSync(fakeHome, { recursive: true, force: true });
    }
  });

  it("raises one stable human alarm identity when the real presence read has no turns", async () => {
    const remote = api({ outboxAlert: assignmentAlert });
    const onAssignmentUnavailable = vi.fn(async () => ({ sent: true }));
    const request = () => pollWatchdogOutboxes({
      config: config(), readToken: READ, adminToken: ADMIN,
      fetchImpl: remote.fetchImpl, deliver: vi.fn(), now: () => 700_000,
      availability: async () => ({ eligible: false, reason: "no-turn-data", idleForMs: null }),
      onAssignmentUnavailable,
    });

    await expect(request()).rejects.toThrow(/1 pending alert/u);
    await expect(request()).rejects.toThrow(/1 pending alert/u);
    expect(onAssignmentUnavailable).toHaveBeenCalledTimes(2);
    const calls = onAssignmentUnavailable.mock.calls.map(([value]) => value);
    expect(calls[0]).toMatchObject({ projectId: "source", target: { agent: "lsrc", pane: 4 },
      state: { reason: "no-turn-data" }, ownerAckClockStarted: false,
      alarmReason: "assignment-offer-never-attempted:no-turn-data" });
    expect(calls[0].idempotencyKey).toMatch(/^suggestions-watchdog-availability:[a-f0-9]{64}$/u);
    expect(calls[1].idempotencyKey).toBe(calls[0].idempotencyKey);
    expect(calls[0].message).toContain("fick aldrig frågan");
    expect(calls[0].message).toContain("ownerAckClockStarted=false");
  });

  it("defaults to registry discovery and keeps a bounded explicit project override", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "amux-watchdog-config-"));
    const path = join(rootDir, "watchdog.yaml");
    try {
      writeFileSync(path, "baseUrl: https://suggest.v1d.io\n");
      expect(loadWatchdogOutboxConfig(path)).toMatchObject({
        projects: null,
        discoveryProject: "source",
      });

      writeFileSync(path, "baseUrl: https://suggest.v1d.io\nprojects: [source, ai]\n");
      expect(loadWatchdogOutboxConfig(path)).toMatchObject({
        projects: ["source", "ai"],
        discoveryProject: "source",
      });
      writeFileSync(path, `baseUrl: https://suggest.v1d.io\nprojects: [${Array.from(
        { length: 33 }, (_, index) => `project${index}`).join(", ")}]\n`);
      expect(() => loadWatchdogOutboxConfig(path)).toThrow(/1-32 project ids/u);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("loads existing standard bearer token characters only from a private file", () => {
    const rootDir = mkdtempSync(join(tmpdir(), "amux-watchdog-credential-"));
    const path = join(rootDir, "token");
    try {
      const token = `${"a".repeat(31)}/`;
      writeFileSync(path, `${token}\n`, { mode: 0o600 });
      expect(loadPrivateCredential(path)).toBe(token);
      writeFileSync(path, `${"a".repeat(31)} \n`, { mode: 0o600 });
      expect(() => loadPrivateCredential(path)).toThrow(/bounded bearer token/u);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("routes the exact immutable prompt to bootstrap brokerOwner and ACKs only its receipt", async () => {
    const remote = api();
    const deliveries = [];
    const result = await pollWatchdogOutboxes({
      config: config(["source", "skydive"]), readToken: READ, adminToken: ADMIN,
      fetchImpl: remote.fetchImpl,
      deliver: async (request) => {
        deliveries.push(request);
        return { jobId: "1".repeat(32), status: "acknowledged", acknowledgedAt: 1_100 };
      },
    });

    expect(result).toEqual({ delivered: 2, pending: 0, projects: 2 });
    expect(deliveries).toEqual([expect.objectContaining({
      agent: "lsrc", pane: 2, prompt: PROMPT,
      idempotencyKey: watchdogDeliveryKey("source", alert.dedupeKey),
    }), expect.objectContaining({
      agent: "skydive", pane: 2, prompt: PROMPT,
      idempotencyKey: watchdogDeliveryKey("skydive", alert.dedupeKey),
    })]);
    expect(remote.calls.filter((call) => call.url.pathname.includes("/api/config"))
      .map((call) => call.url.pathname))
      .toEqual(["/api/config", "/api/config"]);
    const acks = remote.calls.filter((call) => call.url.pathname.endsWith("/ack"));
    expect(acks.map((call) => call.body)).toEqual(["source", "skydive"].map((project) => ({
      id: 7, deliveryReceipt: {
        idempotencyKey: watchdogDeliveryKey(project, alert.dedupeKey),
        jobId: "1".repeat(32), status: "acknowledged", acknowledgedAt: 1_100,
      },
    })));
  });

  it("discovers and routes every public project without a local config edit", async () => {
    const remote = api();
    const deliveries = [];
    const result = await pollWatchdogOutboxes({
      config: config(null), readToken: READ, adminToken: ADMIN,
      fetchImpl: remote.fetchImpl,
      deliver: async (request) => {
        deliveries.push(request);
        return { jobId: "4".repeat(32), status: "acknowledged", acknowledgedAt: 1_500 };
      },
    });

    expect(result).toEqual({ delivered: 4, pending: 0, projects: 4 });
    expect(deliveries.map(({ projectId, agent, pane }) => ({ projectId, agent, pane })))
      .toEqual([
        { projectId: "skydive", agent: "skydive", pane: 2 },
        { projectId: "skyvw", agent: "watch", pane: 2 },
        { projectId: "ai", agent: "ai", pane: 2 },
        { projectId: "source", agent: "lsrc", pane: 2 },
      ]);
    expect(remote.calls.filter((call) => call.url.pathname === "/api/config")
      .map((call) => call.url.searchParams.get("project")))
      .toEqual(["source", ...PUBLIC_PROJECTS]);
  });

  it.each([
    ["duplicates", ["source", "source"], /duplicate project ids/u],
    ["invalid ids", ["source", "Not-Public"], /invalid project id/u],
    ["oversized registries", Array.from({ length: 33 }, (_, index) => `project${index}`), /1-32 project ids/u],
  ])("fails closed before delivery for %s", async (_label, registryProjects, expected) => {
    const remote = api({ registryProjects });
    const deliver = vi.fn();

    await expect(pollWatchdogOutboxes({
      config: config(null), readToken: READ, adminToken: ADMIN,
      fetchImpl: remote.fetchImpl, deliver,
    })).rejects.toThrow(expected);
    expect(deliver).not.toHaveBeenCalled();
    expect(remote.calls.map((call) => call.url.pathname)).toEqual(["/api/config"]);
  });

  it("leaves delivery failures pending and retries once with the same durable identity", async () => {
    const remote = api();
    const deliveries = [];
    const deliver = vi.fn(async (request) => {
      deliveries.push(request);
      if (deliveries.length === 1) throw new Error("broker offline");
      return { jobId: "2".repeat(32), status: "acknowledged", acknowledgedAt: 1_200 };
    });

    await expect(pollWatchdogOutboxes({ config: config(), readToken: READ, adminToken: ADMIN,
      fetchImpl: remote.fetchImpl, deliver })).rejects.toThrow(/1 pending alert/u);
    expect(remote.calls.filter((call) => call.url.pathname.endsWith("/ack"))).toHaveLength(0);

    await expect(pollWatchdogOutboxes({ config: config(), readToken: READ, adminToken: ADMIN,
      fetchImpl: remote.fetchImpl, deliver })).resolves.toMatchObject({ delivered: 1, pending: 0 });
    expect(deliveries.map((request) => request.idempotencyKey))
      .toEqual([watchdogDeliveryKey("source", alert.dedupeKey), watchdogDeliveryKey("source", alert.dedupeKey)]);
    expect(remote.calls.filter((call) => call.url.pathname.endsWith("/ack"))).toHaveLength(1);
  });

  it("keeps an ACK failure retryable and makes the late duplicate receipt harmless", async () => {
    let ackAttempts = 0;
    const remote = api();
    remote.fetchImpl.mockImplementation(async (input, init = {}) => {
      const url = new URL(input);
      remote.calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : null });
      if (url.pathname === "/api/config") return Response.json({
        assignmentBootstrap: { project: { id: "source", brokerOwner: "lsrc:2" } },
        assignmentDelivery: { version: "assignment-delivery.v1", idleMs: 600_000,
          requireExplicitDoneOrSustainedIdle: true, unknownPresence: "deny" },
      });
      if (url.pathname === "/api/watchdog/outbox") return Response.json({ alerts: [alert] });
      if (url.pathname.endsWith("/ack")) {
        ackAttempts += 1;
        return ackAttempts === 1
          ? Response.json({ error: "temporary" }, { status: 503 })
          : Response.json({ acknowledged: true, id: 7 });
      }
      throw new Error("unexpected request");
    });
    const receipt = { jobId: "3".repeat(32), status: "acknowledged", acknowledgedAt: 1_300 };
    const deliver = vi.fn(async () => receipt);

    await expect(pollWatchdogOutboxes({ config: config(), readToken: READ, adminToken: ADMIN,
      fetchImpl: remote.fetchImpl, deliver })).rejects.toThrow(/1 pending alert/u);
    await expect(pollWatchdogOutboxes({ config: config(), readToken: READ, adminToken: ADMIN,
      fetchImpl: remote.fetchImpl, deliver })).resolves.toMatchObject({ delivered: 1 });
    expect(deliver).toHaveBeenCalledTimes(2);
    expect(ackAttempts).toBe(2);
  });

  it("deduplicates durably across restarts and rejects unverified or payload-conflicting receipts", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "amux-watchdog-outbox-"));
    const request = { agent: "lsrc", pane: 2, prompt: PROMPT,
      idempotencyKey: watchdogDeliveryKey("source", alert.dedupeKey), projectId: "source", alert };
    try {
      const queue = createDeliveryQueue({ rootDir });
      const seeded = queue.enqueue({ agentName: "lsrc", pane: 2, text: PROMPT,
        verifyText: PROMPT, kind: "prompt", source: "suggestions-watchdog",
        idempotencyKey: request.idempotencyKey,
        metadata: { projectId: "source", outboxId: alert.id, dedupeKey: alert.dedupeKey } });
      queue.update(seeded, { status: "acknowledged", acknowledgedAt: 1_400, terminalAt: 1_400 });

      const first = await createAmuxOutboxDeliverer({ queue, waitMs: 0 })(request);
      const reopened = createDeliveryQueue({ rootDir });
      const deliverAfterRestart = createAmuxOutboxDeliverer({ queue: reopened, waitMs: 0 });
      expect(await deliverAfterRestart(request)).toEqual(first);
      expect(reopened.list("lsrc", 2)).toHaveLength(1);

      await expect(deliverAfterRestart({ ...request, prompt: `${PROMPT}\nmutated` }))
        .rejects.toThrow(/idempotency payload conflict/u);
      const existing = reopened.findById(first.jobId);
      reopened.update(existing, { status: "delivered_unverified", acknowledgedAt: null });
      await expect(deliverAfterRestart(request)).rejects.toThrow(/not acknowledged/u);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("counts down an unacknowledged delivery and cancels fallback honestly on recovery", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "amux-watchdog-fallback-recovery-"));
    let now = 10_000;
    try {
      const queue = createDeliveryQueue({ rootDir, now: () => now });
      const idempotencyKey = watchdogDeliveryKey("source", alert.dedupeKey);
      const request = { agent: "lsrc", pane: 2, prompt: PROMPT,
        idempotencyKey, projectId: "source", alert };
      const escalate = vi.fn();
      const deliver = createAmuxOutboxDeliverer({ queue, waitMs: 0, now: () => now,
        brokerFallbackAfterMs: 60_000, escalate });

      await expect(deliver(request)).rejects.toThrow(/fallback opens in 60000ms/u);
      expect(escalate).not.toHaveBeenCalled();
      const blocked = queue.list("lsrc", 2)[0];
      expect(blocked).toMatchObject({ status: "pending", acknowledgedAt: null,
        metadata: { watchdogDeliveryGeneration: 1, watchdogFallbackState: "blocked",
          watchdogFallbackDeadlineAt: 70_000, watchdogOwnerAckClockStarted: false } });
      const countdown = watchdogFallbackView(blocked, { now: 65_000 });
      expect(countdown).toMatchObject({ state: "blocked", remainingMs: 5_000,
        ownerAckClockStarted: false, humanEscalation: "none" });
      expect(formatWatchdogFallbackView(countdown)).toContain(
        "state=blocked remaining=5s ownerAckClockStarted=false human=none");

      now = 69_999;
      queue.update(queue.findById(blocked.id), {
        status: "delivering", attempts: 1, firstAttemptAt: 20_000,
      });
      await expect(deliver(request)).rejects.toThrow(/fallback opens in 1ms/u);
      expect(queue.findById(blocked.id).metadata.watchdogFallbackState).toBe("blocked");
      queue.update(queue.findById(blocked.id), {
        status: "acknowledged", acknowledgedAt: now, terminalAt: now,
      });
      await expect(deliver(request)).resolves.toMatchObject({
        jobId: blocked.id, status: "acknowledged", acknowledgedAt: now,
      });
      expect(queue.findById(blocked.id)).toMatchObject({ metadata: {
        watchdogFallbackState: "cancelled", watchdogFallbackCancelledAt: now,
        watchdogFallbackCancelReason: "broker-recovered-before-deadline",
      } });
      expect(escalate).not.toHaveBeenCalled();
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("persists one human fallback across restart at the exact deadline", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "amux-watchdog-fallback-deadline-"));
    let now = 20_000;
    const effects = [];
    const identities = new Set();
    const escalate = vi.fn(async ({ idempotencyKey }) => {
      if (!identities.has(idempotencyKey)) effects.push(idempotencyKey);
      identities.add(idempotencyKey);
      return { sent: true, target: "dm" };
    });
    const request = { agent: "lsrc", pane: 2, prompt: PROMPT,
      idempotencyKey: watchdogDeliveryKey("source", alert.dedupeKey),
      projectId: "source", alert };
    try {
      const queue = createDeliveryQueue({ rootDir, now: () => now });
      const beforeDeadline = createAmuxOutboxDeliverer({ queue, waitMs: 0, now: () => now,
        brokerFallbackAfterMs: 60_000, escalate });
      await expect(beforeDeadline(request)).rejects.toThrow(/fallback opens in 60000ms/u);

      now = 80_000;
      const reopened = createDeliveryQueue({ rootDir, now: () => now });
      const atDeadline = createAmuxOutboxDeliverer({ queue: reopened, waitMs: 0,
        now: () => now, brokerFallbackAfterMs: 60_000, escalate });
      await expect(atDeadline(request)).rejects.toThrow(/human escalation persisted/u);
      await expect(atDeadline(request)).rejects.toThrow(/human escalation persisted/u);
      const job = reopened.list("lsrc", 2)[0];
      expect(job).toMatchObject({ status: "pending", acknowledgedAt: null, metadata: {
        watchdogFallbackState: "escalated", watchdogEscalatedAt: now,
        watchdogEscalationIdempotencyKey: `suggestions-watchdog-fallback:${job.id}:g1`,
        watchdogOwnerAckClockStarted: false,
      } });
      expect(escalate).toHaveBeenCalledTimes(1);
      expect(effects).toEqual([`suggestions-watchdog-fallback:${job.id}:g1`]);
      expect(formatWatchdogFallbackView(watchdogFallbackView(job, { now })))
        .toContain("state=escalated remaining=0s ownerAckClockStarted=false human=sent");
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("retries an ambiguous human fallback with the same identity and no duplicate effect", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "amux-watchdog-fallback-ambiguous-"));
    const now = 90_000;
    const effects = new Set();
    const calls = [];
    const request = { agent: "lsrc", pane: 2, prompt: PROMPT,
      idempotencyKey: watchdogDeliveryKey("source", alert.dedupeKey),
      projectId: "source", alert };
    try {
      const firstQueue = createDeliveryQueue({ rootDir, now: () => 30_000 });
      await expect(createAmuxOutboxDeliverer({ queue: firstQueue, waitMs: 0,
        now: () => 30_000, brokerFallbackAfterMs: 60_000,
        escalate: vi.fn() })(request)).rejects.toThrow(/fallback opens/u);

      const ambiguous = async ({ idempotencyKey }) => {
        calls.push(idempotencyKey);
        effects.add(idempotencyKey);
        throw new Error("notification receipt lost");
      };
      const deadlineQueue = createDeliveryQueue({ rootDir, now: () => now });
      await expect(createAmuxOutboxDeliverer({ queue: deadlineQueue, waitMs: 0,
        now: () => now, brokerFallbackAfterMs: 60_000,
        escalate: ambiguous })(request)).rejects.toThrow(/notification receipt lost/u);

      const recovered = async ({ idempotencyKey }) => {
        calls.push(idempotencyKey);
        const deduped = effects.has(idempotencyKey);
        effects.add(idempotencyKey);
        return { sent: !deduped, deduped, target: "dedupe" };
      };
      const restartedQueue = createDeliveryQueue({ rootDir, now: () => now });
      await expect(createAmuxOutboxDeliverer({ queue: restartedQueue, waitMs: 0,
        now: () => now, brokerFallbackAfterMs: 60_000,
        escalate: recovered })(request)).rejects.toThrow(/human escalation persisted/u);
      expect(new Set(calls).size).toBe(1);
      expect(effects.size).toBe(1);
      expect(restartedQueue.list("lsrc", 2)[0]).toMatchObject({
        metadata: { watchdogFallbackState: "escalated" },
      });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("re-enqueues one proven not-sent cancellation once across restart instead of latching it forever", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "amux-watchdog-cancelled-"));
    const idempotencyKey = watchdogDeliveryKey("source", alert.dedupeKey);
    const request = { agent: "lsrc", pane: 2, prompt: PROMPT,
      idempotencyKey, projectId: "source", alert };
    const now = 61_001;
    try {
      const queue = createDeliveryQueue({ rootDir, now: () => now });
      const seeded = queue.enqueue({ agentName: "lsrc", pane: 2, text: PROMPT,
        verifyText: PROMPT, kind: "prompt", source: "suggestions-watchdog",
        idempotencyKey,
        metadata: { projectId: "source", outboxId: alert.id, dedupeKey: alert.dedupeKey } });
      queue.update(seeded, { status: "cancelled", terminalAt: 1_000, nextAttemptAt: null,
        cancelRequestStatus: "completed", metadata: { deliveryOutcome: "not-sent" },
        lastReason: "not sent: target was not ingesting" });

      const deliver = createAmuxOutboxDeliverer({ queue, waitMs: 0,
        now: () => now, cancelledRetryAfterMs: 60_000 });
      await expect(deliver(request)).rejects.toThrow(/fallback opens in 300000ms/u);
      expect(queue.findById(seeded.id)).toMatchObject({ status: "pending", terminalAt: null,
        metadata: { watchdogReenqueueCount: 1, watchdogReenqueuedAt: now,
          watchdogDeliveryGeneration: 2, watchdogFallbackState: "blocked" } });

      const reopened = createDeliveryQueue({ rootDir, now: () => now });
      const afterRestart = createAmuxOutboxDeliverer({ queue: reopened, waitMs: 0,
        now: () => now, cancelledRetryAfterMs: 60_000 });
      await expect(afterRestart(request)).rejects.toThrow(/fallback opens in 300000ms/u);
      expect(reopened.findById(seeded.id)).toMatchObject({ status: "pending",
        metadata: { watchdogReenqueueCount: 1 } });

      reopened.update(reopened.findById(seeded.id), {
        status: "acknowledged", acknowledgedAt: now + 1, terminalAt: now + 1,
      });
      await expect(afterRestart(request)).resolves.toEqual({
        jobId: seeded.id, status: "acknowledged", acknowledgedAt: now + 1,
      });
      expect(reopened.list("lsrc", 2)).toHaveLength(1);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it("persists one human escalation when the bounded re-enqueue is cancelled again", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "amux-watchdog-escalated-"));
    let now = 120_000;
    try {
      const queue = createDeliveryQueue({ rootDir, now: () => now });
      const idempotencyKey = watchdogDeliveryKey("source", alert.dedupeKey);
      const seeded = queue.enqueue({ agentName: "lsrc", pane: 2, text: PROMPT,
        verifyText: PROMPT, kind: "prompt", source: "suggestions-watchdog",
        idempotencyKey, metadata: { projectId: "source", outboxId: alert.id,
          dedupeKey: alert.dedupeKey, deliveryOutcome: "not-sent",
          watchdogReenqueueCount: 1 } });
      queue.update(seeded, { status: "cancelled", terminalAt: 60_000,
        nextAttemptAt: null, lastReason: "not sent after the bounded re-enqueue" });
      const request = { agent: "lsrc", pane: 2, prompt: PROMPT,
        idempotencyKey, projectId: "source", alert };
      const escalate = vi.fn(async () => ({ sent: true, target: "dm" }));
      const deliver = createAmuxOutboxDeliverer({ queue, waitMs: 0, now: () => now,
        escalate });

      await expect(deliver(request)).rejects.toThrow(/human escalation persisted/u);
      expect(queue.findById(seeded.id)).toMatchObject({ status: "cancelled",
        metadata: { watchdogReenqueueCount: 1, watchdogEscalatedAt: now,
          watchdogEscalationReason: "not-sent-after-bounded-reenqueue" } });
      now += 60_000;
      await expect(deliver(request)).rejects.toThrow(/human escalation persisted/u);
      expect(queue.findById(seeded.id).metadata.watchdogEscalatedAt).toBe(120_000);
      expect(escalate).toHaveBeenCalledTimes(1);
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });

  it.each([
    ["missing", "", "schema: broker_check_due resolvedPrompt is missing"],
    ["oversized", "x".repeat(32 * 1024 + 1),
      "schema: broker_check_due resolvedPrompt is oversized"],
  ])("classifies %s broker-check prompts without conflating schema failures",
    async (_label, resolvedPrompt, expected) => {
      const remote = api({ outboxAlert: { ...alert,
        payload: { ...alert.payload, resolvedPrompt } } });
      let failure;
      try {
        await pollWatchdogOutboxes({ config: config(), readToken: READ, adminToken: ADMIN,
          fetchImpl: remote.fetchImpl, deliver: vi.fn() });
      } catch (error) { failure = error; }
      expect(failure).toBeInstanceOf(AggregateError);
      expect(failure.errors.map((error) => error.message)).toEqual([`source/7: ${expected}`]);
    });

  it("does not let one malformed broker check starve a later assignment offer", async () => {
    const malformed = { ...alert, payload: { ...alert.payload, resolvedPrompt: "" } };
    const remote = api({ outboxAlerts: [malformed, assignmentAlert] });
    const deliver = vi.fn(async () => ({
      jobId: "8".repeat(32), status: "acknowledged", acknowledgedAt: 2_100,
    }));

    let failure;
    try {
      await pollWatchdogOutboxes({ config: config(), readToken: READ, adminToken: ADMIN,
        fetchImpl: remote.fetchImpl, deliver,
        availability: async () => ({ eligible: true, reason: "explicit-done" }) });
    } catch (error) { failure = error; }
    expect(failure).toBeInstanceOf(AggregateError);
    expect(failure.errors.map((error) => error.message)).toEqual([
      "source/7: schema: broker_check_due resolvedPrompt is missing",
    ]);
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      prompt: assignmentAlert.payload.offerPrompt, alert: expect.objectContaining({ id: 8 }),
    }));
    expect(remote.calls.filter((call) => call.url.pathname.endsWith("/ack")))
      .toHaveLength(1);
  });

  it("recovers a legacy empty off-board prompt only from the hash-bound current template", async () => {
    const template = "BROKER CHECK — {{ticket.id}} — assignment {{assignment.generation}}\n"
      + "Legacy off-board compatibility.";
    const templateHash = `sha256:${createHash("sha256").update(template).digest("hex")}`;
    const legacy = { ...alert, payload: { ...alert.payload, resolvedPrompt: "", generation: 2,
      templateVersion: "off-board.v1", templateHash, overrideScope: "default" } };
    const remote = api({ outboxAlert: legacy, watchdogPolicy: {
      resolvedPromptTemplate: template, templateVersion: "1.0.0", templateHash,
      overrideScope: "default",
    } });
    const deliver = vi.fn(async () => ({
      jobId: "7".repeat(32), status: "acknowledged", acknowledgedAt: 1_100,
    }));

    await expect(pollWatchdogOutboxes({ config: config(), readToken: READ, adminToken: ADMIN,
      fetchImpl: remote.fetchImpl, deliver })).resolves.toMatchObject({ delivered: 1, pending: 0 });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({
      prompt: "BROKER CHECK — SRC-0025 — assignment 2\nLegacy off-board compatibility.",
    }));

    const mismatch = api({ outboxAlert: { ...legacy, payload: {
      ...legacy.payload, templateHash: `sha256:${"0".repeat(64)}`,
    } }, watchdogPolicy: {
      resolvedPromptTemplate: template, templateVersion: "1.0.0", templateHash,
      overrideScope: "default",
    } });
    let failure;
    try {
      await pollWatchdogOutboxes({ config: config(), readToken: READ, adminToken: ADMIN,
        fetchImpl: mismatch.fetchImpl, deliver: vi.fn() });
    } catch (error) { failure = error; }
    expect(failure.errors.map((error) => error.message)).toEqual([
      "source/7: schema: broker_check_due resolvedPrompt is missing",
    ]);
  });
});
