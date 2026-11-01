import { listAgents } from "../cli/config.mjs";
import { readAlternateTurns } from "./alternate-session-reader.mjs";
import { panePathFor, readLastTurns } from "./jsonl-reader.mjs";

// The last turn fits in 256 KB even with chunky tool output; journals can be 100 MB+.
const TAIL_BYTES = 256 * 1024;

// Headless: a long turn's prompt can lie before the tail, and only its words are needed here.
function readPaneTurns(agent, paneIdx) {
  const paneDir = panePathFor(agent, paneIdx);
  const options = { limit: 4, tailBytes: TAIL_BYTES, headless: true };
  return readAlternateTurns(agent.panes?.[paneIdx]?.cmd || "", paneDir, options) || readLastTurns(paneDir, options);
}

/** WHAT: Returns one pane's last assistant text from its journal tail, or "". WHY: Keeps a voice message's terms tied to the words it answers. */
export function paneLatestReply(agent, paneIdx, { readTurns = readPaneTurns } = {}) {
  const turns = readTurns(agent, paneIdx)?.turns || [];
  for (let i = turns.length - 1; i >= 0; i--) {
    const items = turns[i].items || [];
    for (let j = items.length - 1; j >= 0; j--) {
      if (items[j].type === "tool") continue;
      const text = String(items[j].content || "").trim();
      if (text) return text;
    }
  }
  return "";
}

/** WHAT: Builds the by-name reader the voice paths call before transcribing. WHY: Keeps an unreadable journal from stopping a voice message. */
export function createPaneReplyReader(agentsYamlPath, { loadAgents = listAgents, readTurns } = {}) {
  return (name, pane) => {
    try {
      const agent = loadAgents(agentsYamlPath).find((entry) => entry.name === name);
      return agent ? paneLatestReply(agent, pane, readTurns ? { readTurns } : {}) : "";
    } catch (error) {
      console.warn(`voice context ${name}:${pane}: latest reply unreadable, transcribing without it: ${error.message}`);
      return "";
    }
  };
}

// ~/bin/transcribe spells the heard words against V1D_CONTEXT through /v1/proofread and cuts it to the gateway's
// limit (ai:1 1 Nov: "porslinshand" with the pane's reply, "pusslinhand" without).
/** WHAT: Builds the transcriber environment for one voice message. WHY: Keeps a pane without a reply from sending any context. */
export function voiceContextEnv(reply) {
  return reply ? { V1D_CONTEXT: reply } : {};
}
