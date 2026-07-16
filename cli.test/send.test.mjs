import { component, expect, feature } from "bdd-vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { createDeliveryQueue } from "../core/delivery-queue.mjs";
import { sendToPane } from "../cli/tmux.mjs";
import { premiseEnvelope } from "../core/premise-stamp.mjs";

const tempRoot = () => mkdtempSync(join(tmpdir(), "amux-send-receipt-"));
const PREMISE = Object.freeze({ schemaVersion: 1, producer: "amux.premise-proof.v1",
  observedAt: 1, selectors: {}, basis: {}, attestationHash: `sha256:${"a".repeat(64)}` });

feature("inter-agent send receipts", () => {
  component("unstamped cross-agent briefs are rejected at the durable queue boundary", {
    given: ["an empty spool and a hand-written sender header", () => {
      const rootDir = tempRoot();
      return { rootDir, queue: createDeliveryQueue({ rootDir }) };
    }],
    when: ["an alternate caller tries to bypass premise capture", async ({ queue }) => {
      try {
        await sendToPane({ deliveryQueue: queue, configPath: null }, "lsrc", 6,
          "[from lsrc:2]\n\nstale instruction", { force: true, mirror: false, waitMs: 0 });
      } catch (error) { return error; }
      return null;
    }],
    then: ["the brief is rejected before any durable or physical delivery artifact", (error, ctx) => {
      expect(error?.message).toContain("tool-generated amux.premise-proof.v1 attestation");
      expect(ctx.queue.list("lsrc", 6)).toHaveLength(0);
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });

  component("durable acceptance is not reported as delivery", {
    given: ["a persisted brief whose target has not acknowledged it", () => {
      const rootDir = tempRoot();
      const queue = createDeliveryQueue({ rootDir });
      return { rootDir, queue };
    }],
    when: ["the CLI wait window expires while the job is still pending", ({ queue }) =>
      sendToPane({ deliveryQueue: queue, configPath: null }, "lsrc", 6,
        `[from lsrc:2]\n\n${premiseEnvelope(PREMISE)}\n\nSRC-0093 must not act before premise verification`, {
          force: true, mirror: false, waitMs: 0, premiseStamp: PREMISE,
        })],
    then: ["the receipt distinguishes accepted from delivered", (result, ctx) => {
      expect(result).toMatchObject({
        accepted: true,
        delivered: false,
        pending: true,
        queueState: "pending",
      });
      expect(ctx.queue.list("lsrc", 6)).toHaveLength(1);
      rmSync(ctx.rootDir, { recursive: true, force: true });
    }],
  });
});
