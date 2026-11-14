// Which compactions a pane's channel has not been told about, and the one
// line that tells it. Pure, so the watcher only does the I/O.

const clock = (iso) => new Date(iso).toLocaleTimeString("sv-SE", { hour: "2-digit", minute: "2-digit" });
const timeOf = (event) => Date.parse(String(event?.timestamp || ""));

// The watcher reads a small tail while running and a larger one at startup, so
// a restart reveals older compacts the small tail never held. They were posted
// as new (skydive:0, 2026-09-27: compacts from 26-27 Sep as "3 times while the
// bridge was offline"). A tail is a suffix of the journal, so a compact older
// than the newest one already seen is old news.
/**
 * WHAT: Returns the compactions a channel has not been told about.
 * WHY: Keeps a restart's larger startup read from re-announcing compacts older than the newest one seen.
 */
export function compactionsToAnnounce(events, seenIds) {
  const seenTimes = events.filter((event) => seenIds.has(event.id)).map(timeOf).filter(Number.isFinite);
  const newestSeen = seenTimes.length ? Math.max(...seenTimes) : -Infinity;
  return events.filter((event) => event.id && !seenIds.has(event.id) && !(timeOf(event) <= newestSeen));
}

/** WHAT: Reads the compact cause for an exact-session journal boundary. WHY: Prevents a stale pane reason from reaching another session. */
export function compactCauseForEvent(event, receipt, sessionPath) {
  const time = timeOf(event);
  if (!receipt?.compactCause || !Number.isFinite(time) || !Number.isFinite(receipt.at)
      || receipt.sessionPath !== sessionPath || time < receipt.at || time - receipt.at > 40 * 60_000
      || Number.isFinite(receipt.finishedAt) && time > receipt.finishedAt + 120_000) return null;
  return receipt.compactCause;
}

/**
 * WHAT: Formats the one notice for new compactions with their clock times.
 * WHY: Keeps a late notice after a restart from implying the compaction happened just now.
 */
export function compactionNoticeText(paneName, compactions) {
  const times = compactions.map((event) => event.timestamp).filter((ts) => Number.isFinite(Date.parse(ts))).map(clock);
  const when = times.length ? ` (${times.join(", ")})` : "";
  const causes = compactions.map(event => event.cause || "cause unavailable").join("; ");
  return compactions.length === 1
    ? `Context compacted for **${paneName}**${when}. Cause: ${causes}. The summary is available for the next turn.`
    : `Context compacted ${compactions.length} times for **${paneName}**${when}. Causes: ${causes}. The latest summary is available for the next turn.`;
}
