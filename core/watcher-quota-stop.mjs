import { claudeLimitFromText } from "./claude-limit-evidence.mjs";
import { isHarnessPlaceholder } from "./reply-forwarder.mjs";

/** WHAT: Filters repeated exact plan-stop text within one unchanged journal episode.
 * WHY: Background completions generate new item ids without a new quota incident. */
export function planQuotaStopMirror(turn, previous = null) {
  const items = turn.items || [], endMs = Date.parse(turn.endTimestamp || turn.timestamp || "");
  let next = previous, stopped = previous?.text || null;
  const kept = items.filter(item => {
    if (item.type !== "text") return true;
    const text = String(item.content || "").trim();
    if (claudeLimitFromText(text)) {
      const repeated = turn.taskNotification === true && stopped === text;
      stopped = text;
      if (!previous?.at || endMs >= previous.at) next = { text, at: endMs };
      return !repeated;
    }
    if (text && !isHarnessPlaceholder(text) && (!previous?.at || endMs >= previous.at)) {
      stopped = null;
      next = { text: null, at: endMs };
    }
    return true;
  });
  return { turn: { ...turn, items: kept }, next };
}
