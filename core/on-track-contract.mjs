/** WHAT: Defines whether a ledger row is active under the approved review scope. WHY: Keeps parked and terminal work out of the progress check without using estimates as a stop. */
export function activeOnTrackRow(row) {
  const state = String(row.state || "").toLowerCase();
  if (/^(closed|done|dropped|later|stängd|struken|klar|avslutad|levererad|parked|parkerad|parkerat|planned|proposed)\b/u.test(state)) return false;
  if (/\b(later|parked|parkerad|parkerat)\b/u.test(state) && !/^(working|running|pågår|granskas)\b/u.test(state)) return false;
  return true;
}

/** WHAT: Returns the source interval certified by a valid review. WHY: Prevents review-processing time from dropping intervening human orders. */
export function onTrackCoveredUntil(record, history = []) {
  if (!record?.lastReview?.valid) return null;
  if (Number.isFinite(record.lastReview.coveredUntil)) return record.lastReview.coveredUntil;
  const cycle = [record.cycle, ...history].find(c => c?.review?.valid && c.review.at === record.lastReview.at);
  return Number.isFinite(cycle?.at) ? cycle.at : null;
}

/** WHAT: Checks a leader-approved queue against its named dependency and actual decision source. WHY: Keeps estimates and undocumented waiting from becoming progress exemptions. */
export function leaderQueueStop(stop, { project, cycle, rows, row, verify }) {
  if (stop?.kind !== "leader-queue" || (!stop.predecessor && !stop.gate) || !verify(stop.evidence)) return false;
  if (stop.predecessor && (!rows[stop.predecessor] || String(stop.predecessor) === row.row)) return false;
  const decision = cycle.decisions?.find(d => d.id === stop.decisionId);
  const owners = project.decisionOwners || [project.dispatcher];
  if (!decision || !owners.includes(decision.by)) return false;
  const token = String(stop.predecessor || stop.gate).toLowerCase();
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  return token.trim().length > 0 && new RegExp(`(?:^|[^\\p{L}\\p{N}_])${escaped}(?:$|[^\\p{L}\\p{N}_])`, "u").test(String(decision.text || "").toLowerCase());
}
