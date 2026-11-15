/** WHAT: Tracks prolonged swap exhaustion and emits bounded alerts. WHY: Keeps swap episodes separate from memory admission. */
export function createSwapAlarm({ clock = Date.now, census, sendAgent, sendHuman, log = console.warn }) {
  let lowSince = null, lastNotice = null, humanNotified = false, running = false;
  return async sample => {
    const now = clock();
    if (!Number.isFinite(sample.swapFreeKb) || !Number.isFinite(sample.swapTotalKb)) return;
    if (!(sample.swapTotalKb > 0 && sample.swapFreeKb / sample.swapTotalKb < 0.1)) {
      lowSince = null; lastNotice = null; humanNotified = false; return;
    }
    if (lowSince === null) lowSince = now;
    if (now - lowSince < 600_000 || running) return;
    if (lastNotice !== null && now - lastNotice < 3_600_000) return;
    const episode = lowSince;
    running = true;
    try {
      const groups = await census();
      if (lowSince !== episode) return;
      log(`[memory-guard] swap under 10% free: top process groups\n${groups.join("\n")}`);
      const text = `Swap has been below 10% free for ${Math.floor((now - lowSince) / 60_000)} min. Largest pane groups: ${groups.slice(0, 3).join("; ")}. Relief: node bin/memory-guard.mjs relieve`;
      await sendAgent(text);
      lastNotice = now;
      if (!humanNotified && now - lowSince >= 4_200_000) {
        await sendHuman(text); humanNotified = true;
      }
    } finally { running = false; }
  };
}
