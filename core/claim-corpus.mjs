import { createHash } from "node:crypto";

/** WHAT: Calculates exact corpus hashes. WHY: Keeps human grading bound to immutable original replies. */
export const claimHash = text => createHash("sha256").update(text).digest("hex");

/** WHAT: Builds a frozen check summary from human labels. WHY: Prevents missing or stale grading from authorizing enforcement. */
export function summarizeClaims(rows, { known = null, review = null, algorithm = null, seed = "claim-guard-v1" } = {}) {
  const holds = rows.filter(row => row.verdict === "hold");
  const corpusSha256 = claimHash(JSON.stringify(rows.map(row => [row.id, row.textSha256])));
  const sample = holds.length <= 50 ? holds : [...holds].sort((a, b) => claimHash(seed + a.id).localeCompare(claimHash(seed + b.id))).slice(0, 50);
  const labels = review?.corpusSha256 === corpusSha256 && review.algorithm === algorithm ? review.labels || [] : [];
  const graded = sample.map(row => labels.find(label => label.id === row.id && label.textSha256 === row.textSha256
    && label.sentencesSha256 === claimHash(JSON.stringify(row.sentences))
    && typeof label.falseStop === "boolean" && label.reason?.trim()));
  const complete = graded.every(Boolean) && Boolean(review) && (sample.length > 0 || review.emptyReviewed === true);
  const caught = target => rows.some(row => row.id === target.id
    && row.sentences.some(sentence => sentence.text.includes(target.claim)));
  const errors = (known?.groups || []).map(group => ({
    name: group.name, kind: group.kind || "factual", detectable: group.detectable !== false,
    caught: group.detectable !== false && group.replies.some(caught),
    strictCaught: group.detectable !== false && group.replies.filter(target => !target.decisionOnly).some(caught),
    variants: [...new Set(group.replies.map(target => target.variant).filter(Boolean))]
      .map(name => ({ name, caught: group.replies.filter(target => target.variant === name).some(caught) })),
  }));
  return {
    corpusSha256, total: rows.length, held: holds.length, shareHeld: rows.length ? holds.length / rows.length : 0,
    sample: sample.map(({ id, textSha256, sentences }) => ({ id, textSha256, sentences,
      sentencesSha256: claimHash(JSON.stringify(sentences)) })),
    reviewed: graded.filter(Boolean).length, reviewComplete: complete,
    falseStops: complete ? graded.filter(label => label.falseStop).length : null,
    falseStopRate: complete ? (graded.filter(label => label.falseStop).length / (sample.length || 1)) : null,
    knownConfirmed: Boolean(known?.confirmedAt && known?.confirmationSource),
    caught: errors.filter(error => error.caught).length, errors,
    strictCaught: errors.filter(error => error.strictCaught).length,
  };
}

/** WHAT: Checks the approved two-day activation thresholds. WHY: Prevents ungraded shadow results from becoming active speech gates. */
export function qualifyClaims(today, heldOut) {
  return Boolean(today?.knownConfirmed && today.errors?.length === 7 && today.caught >= 5 && today.strictCaught >= 5
    && today.algorithm && heldOut?.algorithm === today.algorithm
    && today.day !== heldOut.day && heldOut.day < today.day
    && today.reviewComplete && heldOut?.reviewComplete
    && today.falseStopRate <= 0.10 && heldOut.falseStopRate <= 0.10);
}
