/** WHAT: Returns readiness while a TUI continues progressing.
 *  WHY: Separates slow transcript replay from a truly stalled compositor. */
export async function waitForProgressingUi({
  capture,
  inspect,
  delay,
  now = Date.now,
  hardTimeoutMs = 120_000,
  stallTimeoutMs = 30_000,
  pollMs = 300,
}) {
  const hardDeadline = now() + hardTimeoutMs;
  let stallDeadline = now() + stallTimeoutMs;
  let previous;
  while (now() < hardDeadline && now() < stallDeadline) {
    const screen = await capture().catch(() => "");
    if (screen !== previous) {
      previous = screen;
      stallDeadline = now() + stallTimeoutMs;
    }
    const outcome = await inspect(screen);
    if (outcome === true || outcome?.ready === true) return true;
    await delay(outcome?.waitMs ?? pollMs);
  }
  return false;
}
