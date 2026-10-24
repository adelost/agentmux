/** WHAT: Checks a delivery's persisted pre-submit evidence. WHY: Keeps a stale quota reason from excusing a submitted prompt or a held draft. */
export function isUnsubmittedQuotaJob(job) {
  return ["pending", "delivering"].includes(job?.status) && !job.submittedAt && !job.submitFenceAt
    && !job.acknowledgedAt && !job.draftOwned && job.metadata?.deliveryOutcome !== "unknown";
}

/** WHAT: Checks an unsent delivery's actual quota-floor refusal. WHY: Keeps ordinary pending work outside the maintenance exception. */
export function isUnsentQuotaFloorJob(job) {
  return isUnsubmittedQuotaJob(job) && String(job.lastReason || "").startsWith("wake-refused:quota-floor:");
}
