import { describe, expect, it, vi } from "vitest";
import { createHash } from "crypto";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import {
  createAmuxOutboxDeliverer,
  loadPrivateCredential,
  pollWatchdogOutboxes,
  watchdogDeliveryKey,
} from "./suggestions-watchdog-outbox.mjs";

const READ = "r".repeat(40);
const ADMIN = "a".repeat(40);
const PROMPT = "BROKER CHECK — SRC-0025 — immutable\ncontinue(next checkpoint/recheck)";
const OFFER_PROMPT = "ASSIGNMENT OFFER — SRC-0093 — generation 1\nOwner: lsrc:6";

const canonical = (value) => Array.isArray(value) ? `[${value.map(canonical).join(",")}]`
  : value && typeof value === "object"
    ? `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`
    : JSON.stringify(value);
const premise = (identity) => ({ ...identity,
  attestationHash: `sha256:${createHash("sha256").update(canonical(identity)).digest("hex")}` });

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

const wakeAlert = Object.freeze({
  id: 8,
  ticketId: "SRC-0093",
  assignmentId: 68,
  kind: "assignment_wake_condition_recorded",
  dedupeKey: "assignment-wake:SRC-0093:1:64:1",
  payload: Object.freeze({
    targetAgentId: "lsrc:6",
    assignmentGeneration: 1,
    checkId: "SRC-0093:1:64:1",
    reason: "The merge is broker-owned.",
    wakeCondition: "Wake when origin/main contains the approved merge.",
    checkedAt: 1_000,
    nextCheckAt: 2_000,
    premise: Object.freeze(premise({
      schemaVersion: 1,
      producer: "amux.premise-proof.v1",
      observedAt: 1_000,
      selectors: { sender: "lsrc:2", repository: null, pullRequests: [],
        tickets: [{ projectId: "source", ticketId: "SRC-0093" }] },
      basis: { repository: null, referencedBaseShas: [], pullRequests: [], board: [{
        projectId: "source", ticketId: "SRC-0093", revision: 5,
        status: "in_progress", updatedAt: 1_000,
        assignment: { id: 68, generation: 1, state: "waiting", ownerAgentId: "lsrc:6" },
      }] },
    })),
  }),
  queuedAt: 1_000,
  deliveredAt: null,
});

const offerAlert = Object.freeze({
  id: 9,
  ticketId: "SRC-0093",
  assignmentId: 68,
  kind: "assignment_offer_delivery",
  dedupeKey: "assignment-offer:68:1",
  payload: Object.freeze({
    targetAgent: "lsrc:6",
    offerPrompt: OFFER_PROMPT,
    promptVersion: "1.0.0",
    promptHash: `sha256:${createHash("sha256").update(OFFER_PROMPT).digest("hex")}`,
    completionPolicy: { version: 2, required: true },
  }),
  queuedAt: 1_000,
  deliveredAt: null,
});

function api({ ackStatus = 200, alerts = [alert], ticketRevision = 5 } = {}) {
  const calls = [];
  const fetchImpl = vi.fn(async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, init, body: init.body ? JSON.parse(String(init.body)) : null });
    if (url.pathname === "/api/config/agentdocs") {
      const project = url.searchParams.get("project");
      const prefix = project === "source" ? "lsrc" : "skydive";
      const workerPanes = project === "source" ? [3, 4, 5, 6, 7, 8, 9] : [3, 4];
      return Response.json({ project: {
        id: project,
        routingGuide: { workers: [
          { role: "broker", id: `${prefix}:2` },
          ...workerPanes.map((pane) => ({ role: "worker", id: `${prefix}:${pane}` })),
        ] },
      } });
    }
    if (url.pathname === "/api/watchdog/outbox") return Response.json({ alerts });
    if (url.pathname === "/api/tickets/SRC-0093") return Response.json({ ticket: {
      id: "SRC-0093", revision: ticketRevision, status: "in_progress", updatedAt: 1_000,
      assignment: { id: 68, generation: 1, state: "waiting",
        members: [{ agentId: "lsrc:6", role: "owner" }] },
    } });
    if (url.pathname === "/api/watchdog/outbox/ack") {
      return Response.json(ackStatus === 200 ? { acknowledged: true, id: alerts[0]?.id }
        : { error: "ack-failed" }, { status: ackStatus });
    }
    if (url.pathname === "/api/watchdog/outbox/reject") return Response.json({
      rejected: true, id: alerts[0]?.id,
      attestationHash: alerts[0]?.payload?.premise?.attestationHash,
      detectedAt: calls.at(-1)?.body?.premiseRejection?.detectedAt,
    });
    return Response.json({ error: "not-found" }, { status: 404 });
  });
  return { calls, fetchImpl };
}

const config = (projects = ["source"]) => ({
  baseUrl: "https://suggest.v1d.io",
  projects,
  requestTimeoutMs: 1_000,
});

describe("persistent Suggestions watchdog outbox consumer", () => {
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

    expect(result).toEqual({ delivered: 2, rejected: 0, pending: 0, projects: 2 });
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

  it("routes a waiting wake condition to its stamped owner after exact board-premise verification", async () => {
    const remote = api({ alerts: [wakeAlert] });
    const deliveries = [];
    await expect(pollWatchdogOutboxes({
      config: config(), readToken: READ, adminToken: ADMIN, fetchImpl: remote.fetchImpl,
      deliver: async (request) => {
        deliveries.push(request);
        return { jobId: "4".repeat(32), status: "acknowledged", acknowledgedAt: 1_100 };
      },
    })).resolves.toMatchObject({ delivered: 1, rejected: 0, pending: 0 });

    expect(deliveries).toHaveLength(1);
    expect(deliveries[0]).toMatchObject({ agent: "lsrc", pane: 6 });
    expect(deliveries[0].prompt).toContain("Wake when origin/main contains the approved merge.");
    expect(deliveries[0].prompt).toContain("AMUX PREMISE amux.premise-proof.v1");
    expect(deliveries[0].prompt).toContain("\"revision\":5");
    expect(remote.calls.map((call) => call.url.pathname)).toContain("/api/tickets/SRC-0093");
  });

  it("delivers the machine-attested assignment offer byte-exactly to its owner", async () => {
    const remote = api({ alerts: [offerAlert] });
    const deliveries = [];
    const result = await pollWatchdogOutboxes({
      config: config(), readToken: READ, adminToken: ADMIN, fetchImpl: remote.fetchImpl,
      deliver: async (request) => {
        deliveries.push(request);
        return { jobId: "5".repeat(32), status: "acknowledged", acknowledgedAt: 1_100 };
      },
    });

    expect(result).toMatchObject({ delivered: 1, rejected: 0, pending: 0 });
    expect(deliveries).toEqual([expect.objectContaining({
      agent: "lsrc", pane: 6, prompt: OFFER_PROMPT,
      idempotencyKey: watchdogDeliveryKey("source", offerAlert.dedupeKey),
    })]);
    expect(remote.calls.find((call) => call.url.pathname.endsWith("/ack"))?.body)
      .toEqual({ id: 9, deliveryReceipt: {
        idempotencyKey: watchdogDeliveryKey("source", offerAlert.dedupeKey),
        jobId: "5".repeat(32), status: "acknowledged", acknowledgedAt: 1_100,
      } });
  });

  it("detects a stale board premise before enqueue and never ACKs the original brief", async () => {
    const remote = api({ alerts: [wakeAlert], ticketRevision: 6 });
    const deliver = vi.fn();

    const result = await pollWatchdogOutboxes({
      config: config(), readToken: READ, adminToken: ADMIN, fetchImpl: remote.fetchImpl, deliver,
    });

    expect(result).toEqual({ delivered: 0, rejected: 1, pending: 0, projects: 1 });
    expect(deliver).not.toHaveBeenCalled();
    expect(remote.calls.filter((call) => call.url.pathname.endsWith("/ack"))).toHaveLength(0);
    expect(remote.calls.find((call) => call.url.pathname.endsWith("/reject"))?.body)
      .toMatchObject({ id: 8, premiseRejection: {
        status: "stale", attestationHash: wakeAlert.payload.premise.attestationHash,
        mismatches: ["board"],
      } });
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
