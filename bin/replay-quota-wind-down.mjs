import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { compactPays, windDownStage } from "../core/quota-wind-down.mjs";

/** WHAT: Returns a stop replay with estimated readings and measured pane facts. WHY: Keeps verification independent of live pane messages. */
export function replayWindDownStop(stop) {
  const opened = Date.parse(stop.opened), stopped = Date.parse(stop.stop), resetAt = Date.parse(stop.reset);
  let noticeAt = null, nudgeAt = null, stopAt = null;
  for (let now = opened; now < stopped; now += 1000) {
    const observedAt = opened + Math.floor((now - opened) / 300_000) * 300_000;
    const stage = windDownStage({ now, observedAt, windows: [{ kind: "session", resetsAt: stop.reset,
      usedPercent: 100 * (observedAt - opened) / (stopped - opened) }] });
    if (!stage) continue;
    stopAt = stage.stopAt;
    noticeAt ??= now;
    if (stage.stage === "nudge") nudgeAt ??= now;
  }
  const decisions = Object.entries(stop.panes).map(([pane, facts]) => {
    const pays = compactPays({ engine: "claude", resetAt, stopAt, working: facts.workingAt5,
      lastActivityAt: Date.parse(facts.lastActivityAt), target: null });
    const startAt = facts.workingAt5 ? Date.parse(facts.firstTurnEndAfter5) : noticeAt;
    return { pane, pays, compacted: pays && Number.isFinite(startAt) && startAt + 120_000 <= stopped };
  });
  return { stop: stop.stop, noticeAt: new Date(noticeAt).toISOString(), nudgeAt: new Date(nudgeAt).toISOString(),
    compacted: decisions.filter(decision => decision.compacted).map(decision => decision.pane).sort(), decisions };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const fixture = JSON.parse(readFileSync(new URL("../test/fixtures/quota-wind-down-20261020.json", import.meta.url), "utf8"));
  for (const stop of fixture.stops) {
    const result = replayWindDownStop(stop);
    console.log(`${result.stop}: ${result.compacted.length} compacted: ${result.compacted.join(", ")}`);
    for (const decision of result.decisions) {
      if (decision.compacted !== stop.expectedCompacted.includes(decision.pane)) {
        console.error(`${decision.pane}: mismatch, compactPays=${decision.pays}, turnEnd=${stop.panes[decision.pane].firstTurnEndAfter5}`);
        process.exitCode = 1;
      }
    }
  }
}
