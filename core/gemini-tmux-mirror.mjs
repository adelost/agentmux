import { createHash } from "node:crypto";
import { latestGeminiPrompt } from "./gemini-prompt-echo.mjs";

const STATE_KEY = "gemini_tmux_mirrored_v1";

/** WHAT: Builds completed Gemini reply projection through the existing TUI reader. WHY: Keeps answer/busy observation off Gemini's journal while retaining restart dedupe. */
export function createGeminiTmuxMirror({ agent, state, post, home } = {}) {
  const active = new Set();
  return { async poll({ name, idx, channelId, dir, config }) {
    const key = `${name}:${idx}`;
    if (!dir || active.has(key)) return;
    active.add(key);
    try {
      if (await agent.isBusy(name, idx)) return;
      const prompt = latestGeminiPrompt({ dir, home });
      if (!prompt?.id) return;
      const reply = await agent.getResponseStreamWithRaw(name, idx, prompt.text);
      if (!reply?.items?.some(item => item.type === "text" && item.content?.trim())) return;
      const signature = createHash("sha256").update(JSON.stringify([dir, prompt.id, reply.items])).digest("hex");
      if (state.get(STATE_KEY, {})?.[key] === signature) return;
      const result = await post({ name, idx, channelId, config, turn: { userPrompt: prompt.text,
        timestamp: prompt.timestamp, endTimestamp: prompt.timestamp, isComplete: true, items: reply.items } });
      if (!result?.ok) return;
      const update = current => ({ ...current, [key]: signature });
      if (state.updateKey) state.updateKey(STATE_KEY, update); else state.set(STATE_KEY, update(state.get(STATE_KEY, {})));
    } finally { active.delete(key); }
  } };
}
