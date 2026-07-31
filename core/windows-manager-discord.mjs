import { planAcceptedAction } from "./windows-bridge.mjs";
import { classifyManagerInput } from "./windows-manager-input.mjs";
import { redactSecrets } from "./windows-manager.mjs";

const HISTORY_LIMIT = 10;

function finishAction(state, message, { status, stage, nowMs }) {
  state.lastAction.status = status;
  state.lastAction.completedAt = new Date(nowMs).toISOString();
  state.lastAction.stage = stage;
  state.lastSeenId = String(message.id);
}

/** WHAT: Routes one Discord poll through filters, journal, voice, turn, and cursor. WHY: Keeps delivery ownership in one exactly-once seam. */
export async function pollManagerDiscord({ config, state, history = [], deps, runTurn }) {
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
      continue;
    }
    const command = input.kind === "voice" ? "manager-voice-turn" : "manager-turn";
    state.lastAction = planAcceptedAction({ messageId: message.id, command, generation: deps.generation, nowMs: deps.nowMs() });
    deps.saveState(state);
    deps.log?.(`accepted ${command} message=${message.id} generation=${deps.generation}`);
    const transcription = input.kind === "voice" ? await deps.transcribeMessage(input) : null;
    if (transcription && !transcription.ok) {
      const stage = `transcription-${transcription.reason}`;
      await deps.sendMessage(`AMUX BLOCKED ${stage}`);
      finishAction(state, message, { status: "failed", stage, nowMs: deps.nowMs() });
      deps.saveState(state);
      continue;
    }
    const content = transcription?.text || input.text;
    if (transcription) await deps.sendMessage(`🎙️ ${content}`);
    const turn = await runTurn({ userText: content, messageId: String(message.id), state, history, deps });
    const answer = redactSecrets(turn.answer);
    await deps.sendMessage(answer);
    finishAction(state, message, { status: "completed", stage: turn.outcome, nowMs: deps.nowMs() });
    deps.saveState(state);
    history.push({ role: "user", content }, { role: "assistant", content: answer });
    if (history.length > HISTORY_LIMIT) history.splice(0, history.length - HISTORY_LIMIT);
    handled += 1;
  }
  return handled;
}
