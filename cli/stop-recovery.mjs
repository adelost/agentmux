import { randomUUID } from "node:crypto";
import { appendEvent } from "../core/events.mjs";
import { readLastTurns, panePathFor } from "../core/jsonl-reader.mjs";
import { readAlternateTurns } from "../core/alternate-session-reader.mjs";
import {
  fleetStopRecoveryEvent,
  stopRecoveryCandidate,
} from "../core/fleet-stop-recovery.mjs";
import { getPaneStatus, listPanes } from "./tmux.mjs";

const CODING_COMMAND = /(?:^|[/\s])(claude|codex|kimi(?:-code)?)(?:\s|$)/u;

function readPaneTurns(agent, pane, options) {
  const paneDir = panePathFor(agent, pane);
  const command = agent.panes[pane]?.cmd || "";
  return (readAlternateTurns(command, paneDir, options) || readLastTurns(paneDir, options))?.turns || [];
}

/** WHAT: Returns unfinished panes in sessions about to be killed. WHY: Keeps deliberate same-boot recovery selective. */
export async function collectStopRecoveryCandidates(ctx, agents, sessionNames, nowMs = Date.now()) {
  const live = new Set(sessionNames);
  const tasks = [];
  for (const agent of agents) {
    if (!live.has(agent.name) || agent.backend === "native") continue;
    let resident = new Map();
    try {
      resident = new Map((await listPanes(ctx, agent.name)).map((item) => [item.index, item.command]));
    } catch {}
    for (let pane = 0; pane < (agent.panes || []).length; pane++) {
      if (!CODING_COMMAND.test(String(agent.panes[pane]?.cmd || ""))) continue;
      tasks.push((async () => {
        let paneStatus = "unknown";
        let turns = [];
        try { paneStatus = await getPaneStatus(ctx, agent.name, pane); } catch {}
        try { turns = readPaneTurns(agent, pane, { limit: 4, tailBytes: 8 * 1024 * 1024 }); } catch {}
        return stopRecoveryCandidate({
          agent: agent.name,
          pane,
          paneStatus,
          residentCommand: resident.get(pane) || null,
          turns,
          nowMs,
        });
      })());
    }
  }
  return (await Promise.all(tasks)).filter(Boolean);
}

/** WHAT: Stores the complete recovery set before any tmux kill. WHY: Prevents a destructive action when its receipt cannot be written. */
export function recordStopRecovery(candidates, { now = new Date(), append = appendEvent } = {}) {
  const event = fleetStopRecoveryEvent(candidates, { stopId: randomUUID(), now });
  if (event) append(event);
  return event;
}
