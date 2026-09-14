import { planAcceptedAction } from "./windows-bridge.mjs";
import { classifyManagerInput } from "./windows-manager-input.mjs";
import { redactSecrets } from "./windows-manager.mjs";

const HISTORY_LIMIT = 10;
// About a minute of failed sends at the default 5 s poll before a reply stops holding back new orders.
const MAX_REPLY_ATTEMPTS = 12;

function finishAction(state, message, { status, stage, nowMs }) {
  state.lastAction.status = status;
  state.lastAction.completedAt = new Date(nowMs).toISOString();
  state.lastAction.stage = stage;
  state.lastSeenId = String(message.id);
}

/** WHAT: Dispatches kept replies oldest first and reports whether all landed. WHY: Keeps a failed Discord send a message retry, never a re-run of the order it answers. */
export async function flushPendingReplies(state, deps) {
  const queue = state.pendingReplies || [];
  while (queue.length) {
    const head = queue[0];
    try {
      await deps.sendMessage(head.text);
    } catch (error) {
      head.attempts += 1;
      const dropped = head.attempts >= MAX_REPLY_ATTEMPTS;
      if (dropped) queue.shift();
      deps.log?.(`reply ${dropped ? "dropped" : "kept for retry"} after ${head.attempts} failed sends: ${error?.message || error}`);
      deps.saveState(state);
      if (!dropped) return false;
      continue;
    }
    queue.shift();
    if (head.attempts > 0) deps.saveState(state);
  }
  return true;
}

/** WHAT: Routes one reply behind any kept ones. WHY: Prevents replies from arriving out of order or getting lost when Discord is briefly down. */
export async function deliverReply(state, deps, text) {
  state.pendingReplies = [...(state.pendingReplies || []), { text: String(text), attempts: 0 }];
  return flushPendingReplies(state, deps);
}

/** WHAT: Routes one Discord poll through filters, journal, voice, turn, and cursor. WHY: Keeps delivery ownership in one exactly-once seam. */
export async function pollManagerDiscord({ config, state, history = [], deps, runTurn }) {
  // Older answers land before any new order runs.
  if (!(await flushPendingReplies(state, deps))) return 0;
  const incoming = await deps.listMessages(state.lastSeenId || null);
  const sorted = [...incoming].sort((a, b) => (BigInt(a.id) < BigInt(b.id) ? -1 : 1));
  let handled = 0;
  for (const message of sorted) {
    const unauthorized = message.author?.bot === true
      || String(message.author?.id) !== String(config.authorizedUserId);
    const input = unauthorized ? { kind: "skip", reason: "unauthorized" } : classifyManagerInput(message);
    if (input.kind === "skip") {
      state.lastSeenId = String(message.id);
      deps.saveState(state);
      // Only the authorized human hears why a message did nothing; bots and strangers stay silent.
      if (!unauthorized && !(await deliverReply(state, deps, `AMUX BLOCKED kan inte läsa meddelandet (${input.reason}). Skriv text eller skicka ett röstmeddelande.`))) break;
      continue;
    }
    const command = input.kind === "voice" ? "manager-voice-turn" : "manager-turn";
    // Consumed in the same write that accepts it: an order runs at most once, whatever happens to its reply.
    state.lastAction = planAcceptedAction({ messageId: message.id, command, generation: deps.generation, nowMs: deps.nowMs() });
    state.lastSeenId = String(message.id);
    deps.saveState(state);
    deps.log?.(`accepted ${command} message=${message.id} generation=${deps.generation}`);
    const transcription = input.kind === "voice" ? await deps.transcribeMessage(input) : null;
    if (transcription && !transcription.ok) {
      const stage = `transcription-${transcription.reason}`;
      finishAction(state, message, { status: "failed", stage, nowMs: deps.nowMs() });
      deps.saveState(state);
      if (!(await deliverReply(state, deps, `AMUX BLOCKED ${stage}`))) break;
      continue;
    }
    const content = transcription?.text || input.text;
    if (transcription) await deliverReply(state, deps, `🎙️ ${content}`);
    let turn;
    let status = "completed";
    try {
      turn = await runTurn({ userText: content, messageId: String(message.id), state, history, deps });
    } catch (error) {
      deps.log?.(`turn failed message=${message.id}: ${error?.message || error}`);
      turn = { answer: `AMUX BLOCKED manager-turn-failed: ${error?.message || error}. Skriv //status eller //logs.`, outcome: "BLOCKED" };
      status = "failed";
    }
    const answer = redactSecrets(turn.answer);
    finishAction(state, message, { status, stage: turn.outcome, nowMs: deps.nowMs() });
    deps.saveState(state);
    history.push({ role: "user", content }, { role: "assistant", content: answer });
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
    handled += 1;
    if (!(await deliverReply(state, deps, answer))) break;
  }
  return handled;
}

/** WHAT: Turns a leftover started action into a blocked fence. WHY: Prevents any ambiguous manager action from running twice. */
export function reconcileManagerStartup(state, { nowMs = Date.now() } = {}) {
  const action = state?.lastAction;
  if (!action || action.status !== "started") return { state, fenced: false };
  action.status = "blocked";
  action.completedAt = new Date(nowMs).toISOString();
  action.stage = "crashed-mid-action";
  state.lastAction = action;
  // Phone and Link turns share the journal; only a Discord message id may move the channel cursor.
  if (!String(action.messageId).includes(":")) state.lastSeenId = String(action.messageId);
  return { state, fenced: true, fencedMessageId: String(action.messageId) };
}
