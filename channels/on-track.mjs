import { createOnTrackMonitor, ON_TRACK_STATE } from "../core/on-track-monitor.mjs";
import { readOnTrackProjects, snapshotOnTrackProject, onTrackStore } from "../core/on-track-projects.mjs";
import { notifyUser } from "../cli/send-notify.mjs";

/** WHAT: Builds durable reviews on the normal queue and human notifier. WHY: Keeps scheduling on the existing bridge heartbeat and transport fences. */
export function createOnTrackRuntime({ queue, state = onTrackStore(), projects = readOnTrackProjects,
  snapshot = snapshotOnTrackProject, notify = notifyUser, now = Date.now }) {
  return createOnTrackMonitor({ state, projects, snapshot, now,
    commands: () => state.get(ON_TRACK_STATE)?.commands || {},
    lookup: (key, jobId) => {
      for (const target of queue.targets()) {
        const job = jobId ? queue.read(target.agentName, target.pane, jobId)
          : queue.list(target.agentName, target.pane).find(candidate => candidate.idempotencyKey === key);
        if (job) return job;
      }
      return null;
    },
    send: async (target, text, idempotencyKey) => {
      const [agentName, pane] = target.split(":");
      const job = queue.enqueue({ agentName, pane: Number(pane), text, source: "on-track", idempotencyKey });
      return { id: job.id };
    },
    notifyHuman: (text, idempotencyKey) => notify(text, { strictSingleAttempt: true, idempotencyKey, title: "On-track", level: "warning" }),
  });
}
