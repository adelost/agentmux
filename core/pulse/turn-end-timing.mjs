// WHAT: Keeps the mirror's last posted turn ends, each with when its steps happened, for `amux pulse io`.
// WHY: Row 116d asks turn ends be seen within 1 s; the post ledger only shows when a post started (median 1.47 s after the
// Stop hook on 11 Nov 00:19-00:30Z, 2 of 10 under 1 s), not which step held it.

const MAX_TURN_ENDS = 40;
const rows = [];

/** WHAT: Records one posted turn end; times are ms after the turn's last journal record. WHY: Same clock as the journal. */
export function recordTurnEnd(row) {
  rows.push(row);
  if (rows.length > MAX_TURN_ENDS) rows.shift();
}

/** WHAT: Returns the recorded turn ends, oldest first. WHY: The pulse writer adds them to its snapshot. */
export const turnEndTimings = () => rows.map((row) => ({ ...row }));
