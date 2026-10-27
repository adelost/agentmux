const STOCKHOLM = "Europe/Stockholm";
const LOCAL_NOON_HOUR = 12;
const MIN_WAIT_MS = 15 * 60_000;
const localParts = new Intl.DateTimeFormat("sv-SE", {
  timeZone: STOCKHOLM, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23",
});

/** WHAT: Calculates 12:00 Stockholm time on a Dream date. WHY: Keeps the nightly wait from ending before the digest is read in the morning. */
export function dreamDeadlineMs(dateKey) {
  const [year, month, day] = String(dateKey).split("-").map(Number);
  // Stockholm is UTC+1 or UTC+2, so local noon is 10:00Z or 11:00Z.
  for (const offsetHours of [1, 2]) {
    const candidate = Date.UTC(year, month - 1, day, LOCAL_NOON_HOUR - offsetHours);
    const parts = Object.fromEntries(localParts.formatToParts(candidate).map(({ type, value }) => [type, value]));
    if (`${parts.year}-${parts.month}-${parts.day}` === dateKey && Number(parts.hour) === LOCAL_NOON_HOUR) return candidate;
  }
  throw new Error(`dream-deadline-invalid-date:${dateKey}`);
}

/** WHAT: Calculates when the nightly wait for the curator's file ends. WHY: Keeps a catch-up run that starts after noon from failing before the curator had a fair chance. */
export function dreamWaitDeadlineMs(dateKey, startMs) {
  return Math.max(dreamDeadlineMs(dateKey), startMs + MIN_WAIT_MS);
}
