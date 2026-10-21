import { assertDeliveryPreparation } from "./delivery-preparation.mjs";

/** WHAT: Stores a patch against the current job. WHY: Prevents stale asynchronous delivery work from overwriting a newer attempt after its writer ends. */
export function updateDeliveryJob(job, patch, { read, replace, changed }) {
  assertDeliveryPreparation();
  const current = read(job.agentName, job.pane, job.id);
  if (!current) throw new Error(`delivery job ${job.id} disappeared`);
  const next = {
    ...current,
    ...patch,
    metadata: patch.metadata ? { ...current.metadata, ...patch.metadata } : current.metadata,
  };
  delete next.path;
  replace(current.path, next);
  changed(current.agentName, current.pane);
  return { ...next, path: current.path };
}
