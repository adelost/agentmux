import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { describe, expect, it, vi } from "vitest";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import {
  createAmuxOutboxDeliverer, pollWatchdogOutboxes, watchdogDeliveryKey,
} from "./suggestions-watchdog-outbox.mjs";

const READ = "r".repeat(40);
const ADMIN = "a".repeat(40);
const PROJECT = "source";
const PROMPT = "ASSIGNMENT OFFER — SRC-0121 — generation 2\nOwner: lsrc:4";
const ALERT = Object.freeze({
  id: 800,
  ticketId: "SRC-0121",
  assignmentId: 107,
  kind: "assignment_offer_delivery",
  dedupeKey: "assignment-offer:107:2",
  payload: Object.freeze({
    targetAgent: "lsrc:4",
    offerPrompt: PROMPT,
  }),
  queuedAt: 1_000,
  deliveredAt: null,
});

const config = () => ({
  baseUrl: "https://suggest.v1d.io",
  projects: [PROJECT],
  discoveryProject: PROJECT,
  requestTimeoutMs: 1_000,
});

const api = () => {
  const calls = [];
  const fetchImpl = vi.fn(async (input, init = {}) => {
    const url = new URL(input);
    calls.push({ url, body: init.body ? JSON.parse(String(init.body)) : null });
    if (url.pathname === "/api/config") {
      return Response.json({
        assignmentBootstrap: { project: { id: PROJECT, brokerOwner: "lsrc:2" } },
        assignmentDelivery: {
          version: "assignment-delivery.v1",
          idleMs: 600_000,
          requireExplicitDoneOrSustainedIdle: true,
          unknownPresence: "deny",
        },
      });
    }
    if (url.pathname === "/api/watchdog/outbox") {
      return Response.json({ alerts: [ALERT] });
    }
    if (url.pathname === "/api/watchdog/outbox/ack") {
      return Response.json({ acknowledged: true, id: ALERT.id });
    }
    throw new Error(`unexpected ${url.pathname}`);
  });
  return { calls, fetchImpl };
};

describe("assignment offer receipt reconciliation", () => {
  it("records an already-attempted exact receipt even after the offer makes the pane busy", async () => {
    const rootDir = mkdtempSync(join(tmpdir(), "amux-offer-receipt-"));
    try {
      const queue = createDeliveryQueue({ rootDir });
      const idempotencyKey = watchdogDeliveryKey(PROJECT, ALERT.dedupeKey);
      const job = queue.enqueue({
        agentName: "lsrc",
        pane: 4,
        text: PROMPT,
        verifyText: PROMPT,
        kind: "prompt",
        source: "suggestions-watchdog",
        idempotencyKey,
        metadata: { projectId: PROJECT, outboxId: ALERT.id, dedupeKey: ALERT.dedupeKey },
      });
      queue.update(job, {
        status: "acknowledged",
        attempts: 1,
        acknowledgedAt: 2_000,
        terminalAt: 2_000,
      });
      const deliver = createAmuxOutboxDeliverer({ queue, waitMs: 0 });
      const availability = vi.fn(async () => ({ eligible: false, reason: "pane-working" }));
      const remote = api();

      await expect(pollWatchdogOutboxes({
        config: config(),
        readToken: READ,
        adminToken: ADMIN,
        fetchImpl: remote.fetchImpl,
        deliver,
        availability,
      })).resolves.toEqual({ delivered: 1, pending: 0, projects: 1 });

      expect(availability).not.toHaveBeenCalled();
      expect(remote.calls.find((call) => call.url.pathname.endsWith("/ack"))?.body)
        .toEqual({
          id: ALERT.id,
          deliveryReceipt: {
            idempotencyKey,
            jobId: job.id,
            status: "acknowledged",
            acknowledgedAt: 2_000,
          },
        });
    } finally {
      rmSync(rootDir, { recursive: true, force: true });
    }
  });
});
