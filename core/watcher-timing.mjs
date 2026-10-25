/** WHAT: Returns one timed watcher operation. WHY: Keeps slow stages observable without recording message contents. */
export async function timedWatcherStep(label, work, log) {
  const began = Date.now();
  try { return await work(); }
  finally {
    const elapsed = Date.now() - began;
    if (elapsed >= 1000) { try { log(`stage ${label} ${elapsed}ms`); } catch { /* diagnostics only */ } }
  }
}
