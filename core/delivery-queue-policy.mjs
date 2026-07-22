// Delivery outcome policy is independent from spool persistence.

/** WHAT: Names an unacknowledged terminal delivery. WHY: Keeps every consumer on one persisted state token. */
export const DELIVERED_UNVERIFIED_STATE = "delivered_unverified";

/** WHAT: Defines delivery states that no longer retry. WHY: Keeps queue readers from inventing divergent terminal sets. */
export const TERMINAL_DELIVERY_STATES = new Set([
  "acknowledged", "cancelled", DELIVERED_UNVERIFIED_STATE,
]);

/** WHAT: Checks for a terminal proven not sent. WHY: Keeps cancellation from masquerading as delivery. */
export function isNotSentDeliveryJob(job) {
  return job?.status === "cancelled"
    && (job.metadata?.deliveryOutcome === "not-sent"
      || job.metadata?.deliveryTimeout === "pre-submit");
}

/** WHAT: Checks whether a terminal still needs a receipt. WHY: Keeps live notices visible after queue termination. */
export function needsDeliveryTerminalNotice(job) {
  return (job?.status === DELIVERED_UNVERIFIED_STATE || isNotSentDeliveryJob(job))
    && !job?.unverifiedNoticeSentAt;
}

/** WHAT: Defines the evidence threshold for a non-ingesting target. WHY: Keeps one slow receipt budget from triggering false failure. */
export const NOT_INGESTING_UNVERIFIED_STREAK = 2;

/** WHAT: Calculates unverified terminals after the last receipt. WHY: Keeps later NOT SENT jobs from masking a stalled consumer. */
export function unverifiedStreakSinceLastReceipt(jobs) {
  const lastReceiptAt = jobs.reduce((latest, job) => (job.status === "acknowledged"
    ? Math.max(latest, Number(job.acknowledgedAt || job.terminalAt || 0))
    : latest), 0);
  return jobs.filter((job) => job.status === DELIVERED_UNVERIFIED_STATE
    && Number(job.terminalAt || 0) > lastReceiptAt).length;
}

/** WHAT: Maps a receipt streak to target health. WHY: Keeps each queued job from retrying the same proven wedge. */
export function isTargetProvenNotIngesting(jobs) {
  return unverifiedStreakSinceLastReceipt(jobs) >= NOT_INGESTING_UNVERIFIED_STREAK;
}
