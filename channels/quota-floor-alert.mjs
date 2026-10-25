import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createQuotaFloorAlert } from "../core/quota-floor-alert.mjs";
import { readEvents } from "../core/events.mjs";
import { readQuotaSnapshotWithPanes } from "../core/quota-in-use.mjs";
import { notifyUser } from "../cli/send-notify.mjs";
import { startHeartbeat } from "../core/heartbeat.mjs";
import { readReleaseManifest } from "../core/release-identity.mjs";
import { createQuotaCompactionEvidence } from "./quota-floor-evidence.mjs";
import { createOnTrackRuntime } from "./on-track.mjs";

/** WHAT: Builds the floor notice with existing queue, quota and notification transports. WHY: Keeps the heartbeat observer from moving, waking or resending any delivery. */
export function createQuotaFloorAlertRuntime({ queue, state, configPath, floorPercent,
  readSnapshot = readQuotaSnapshotWithPanes, events = () => readEvents({ tailBytes: 8 * 1024 * 1024 }),
  compactions = null, notifyHuman = notifyUser, now = Date.now,
  log = message => console.log(`quota-floor-alert | ${message}`) }) {
  const readCompactions = compactions || createQuotaCompactionEvidence({ configPath, now });
  const lookupDispatcher = (idempotencyKey, receipt) => receipt?.jobId
    ? queue.read("lsrc", 3, receipt.jobId)
    : queue.list("lsrc", 3).find(job => job.idempotencyKey === idempotencyKey);
  return createQuotaFloorAlert({ state, floorPercent, now, log,
    readEvidence: async () => {
      const snapshot = await readSnapshot();
      const jobs = queue.targets().flatMap(target => queue.list(target.agentName, target.pane));
      const refusals = events().filter(row => row.event === "delivery_queue" && row.state === "wake_refused"
        && String(row.reason || "").startsWith("quota-floor:")).map(row => ({ jobId: row.jobId, at: Date.parse(row.ts), reason: row.reason }));
      return { snapshot, jobs, refusals, compactions: readCompactions(jobs) };
    },
    notifyHuman: (text, idempotencyKey) => notifyHuman(text, { strictSingleAttempt: true, idempotencyKey,
      title: "Leveranser väntar på kvot", level: "warning" }),
    notifyDispatcher: async (text, idempotencyKey) => {
      const job = queue.enqueue({ agentName: "lsrc", pane: 3, text, source: "quota-floor-alert", idempotencyKey });
      return { jobId: job.id };
    }, lookupDispatcher,
  });
}

/** WHAT: Builds the existing identity heartbeat and accepts its quota observer later. WHY: Keeps initialization order from adding a second timer. */
export function startQuotaFloorHeartbeat({ packageRoot, hintsVersion }) {
  let observer = null, reviews = null, version = "unknown";
  try { version = JSON.parse(readFileSync(join(packageRoot, "package.json"), "utf8")).version; } catch {}
  startHeartbeat({ version, sourceSha: readReleaseManifest(packageRoot)?.sourceSha || null,
    hintsVersion, onTick: async () => {
      const results = await Promise.allSettled([observer?.tick(), reviews?.tick()]);
      for (const result of results) if (result.status === "rejected") console.warn(`heartbeat observer failed: ${result.reason?.message}`);
    } });
  return dependencies => {
    observer = createQuotaFloorAlertRuntime(dependencies);
    reviews = createOnTrackRuntime({ queue: dependencies.queue });
    return observer;
  };
}
