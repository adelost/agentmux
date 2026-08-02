import { rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { describe, expect, it } from "vitest";
import { createDeliveryQueue } from "./delivery-queue.mjs";
import { createIngestProbeGate } from "./ingest-probe-gate.mjs";

describe("durable ingest probe gate", () => {
  it("persists probe ownership and resumes it before the normal probe interval", async () => {
    const rootDir = join(tmpdir(), `amux-ingest-gate-${process.pid}-${Date.now()}`);
    let clock = 4_000_000;
    const queue = createDeliveryQueue({ rootDir, now: () => clock });
    let job = queue.enqueue({ agentName: "skydive", pane: 12, text: "real payload" });
    job = queue.update(job, { attempts: 2, lastProbeAt: 0, nextAttemptAt: 0 });
    const calls = [];
    const plan = { version: 1, nonce: "m-1234abcd", cursor: { kind: "test" } };
    const agent = {
      probeIngest: async (_name, _pane, options) => {
        calls.push(options.prepared);
        if (!options.prepared) {
          await options.onPrepared(plan);
          return { ok: false, reason: "first Enter was lost" };
        }
        return { ok: true, nonce: plan.nonce, recovered: true };
      },
    };
    const gate = createIngestProbeGate({
      agent,
      queue,
      queueEvent: () => {},
      now: () => clock,
      blockedRetryMs: () => 1_000,
      probeIntervalMs: 120_000,
    });

    const first = await gate(job);
    expect(first.proceed).toBe(false);
    expect(first.job.metadata.ingestProbe).toEqual(plan);

    // Re-open the spool as a replacement bridge process would. Recovery must
    // come from bytes on disk, not the first gate's job object or queue cache.
    clock += 1_000;
    const restartedQueue = createDeliveryQueue({ rootDir, now: () => clock });
    const restartedJob = restartedQueue.read("skydive", 12, job.id);
    const restartedGate = createIngestProbeGate({
      agent,
      queue: restartedQueue,
      queueEvent: () => {},
      now: () => clock,
      blockedRetryMs: () => 1_000,
      probeIntervalMs: 120_000,
    });
    const second = await restartedGate(restartedJob);
    expect(second.proceed).toBe(true);
    expect(second.job.metadata.ingestProbe).toBeNull();
    expect(calls).toEqual([null, plan]);
    rmSync(rootDir, { recursive: true, force: true });
  });
});
