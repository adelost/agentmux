import { describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import {
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

function api({ ackStatus = 200, registryProjects = PUBLIC_PROJECTS } = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : null });
    if (url.pathname === "/api/config") return Response.json({
      project: { id: url.searchParams.get("project") },
      projects: registryProjects.map((id) => ({ id })),
    });
    if (url.pathname === "/api/config/agentdocs") return Response.json({
      project: {
        id: url.searchParams.get("project"),
        routingGuide: { workers: [{ role: "broker",
          id: PROJECT_BROKERS[url.searchParams.get("project")] }] },
      },
    });
    if (url.pathname === "/api/watchdog/outbox") return Response.json({ alerts: [alert] });
    if (url.pathname === "/api/watchdog/outbox/ack") {
      return Response.json(ackStatus === 200 ? { acknowledged: true, id: alert.id }
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
      .toEqual(["/api/config/agentdocs", "/api/config/agentdocs"]);
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
    expect(remote.calls.filter((call) => call.url.pathname === "/api/config")).toHaveLength(1);
    expect(remote.calls.filter((call) => call.url.pathname === "/api/config/agentdocs")
      .map((call) => call.url.searchParams.get("project"))).toEqual(PUBLIC_PROJECTS);
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
      if (url.pathname === "/api/config/agentdocs") return Response.json({
        project: { id: "source", routingGuide: { workers: [{ role: "broker", id: "lsrc:2" }] } },
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
});
