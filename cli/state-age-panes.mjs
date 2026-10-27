import { readLastTurns, panePathFor } from "../core/jsonl-reader.mjs";
import { readLastTurnsCodex } from "../core/codex-jsonl-reader.mjs";
import { readLastTurnsKimi } from "../core/kimi-jsonl-reader.mjs";
import { readLastTurnsQwen } from "../core/qwen-jsonl-reader.mjs";
import { dialectFor } from "./inspect-pane.mjs";
import { groupNativeTurns } from "../channels/native-runtime-watcher.mjs";

const readers = { claude: readLastTurns, codex: readLastTurnsCodex, kimi: readLastTurnsKimi, qwen: readLastTurnsQwen };

/** WHAT: Builds the ps JSON output with its bounded clocks. WHY: Keeps JSON consumers on the ordinary ps status path. */
export async function printStateAgePanes(agentData, ctx) {
  console.log(JSON.stringify({ observedAt: new Date().toISOString(), panes: await stateAgePaneClocks(agentData, ctx) }));
}

/** WHAT: Builds bounded journal clocks for the actual ps observations. WHY: Keeps missing history from becoming invented idle or working duration. */
export async function stateAgePaneClocks(agentData, ctx) {
  const panes = [];
  for (const { agent, panes: observed } of agentData) for (const pane of observed) {
    const dialect = dialectFor(agent, pane);
    if (!dialect) continue;
    let turn = null, error = null;
    try {
      if (agent.backend === "native") turn = groupNativeTurns((await ctx.agent.nativeRuntime.history(agent.name, pane.index)).events).at(-1);
      else turn = readers[dialect]?.(panePathFor(agent, pane.index), { limit: 1, tailBytes: 1024 * 1024 })?.turns?.at(-1);
    } catch (cause) { error = cause.message; }
    const status = pane.modelView?.running === false ? "stopped" : pane.status;
    const stamp = value => Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
    panes.push({ key: `${agent.name}:${pane.index}`, status, dialect,
      workingSince: status === "working" && turn?.isComplete === false ? stamp(turn.timestamp) : null,
      idleSince: ["idle", "stopped"].includes(status) && turn?.isComplete === true
        ? stamp(turn.replyTimestamp || turn.endTimestamp) : null,
      clockSource: turn ? "bounded current-session journal" : "unknown", error });
  }
  return panes;
}
