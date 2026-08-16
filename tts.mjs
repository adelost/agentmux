// TTS: text-to-speech via edge-tts. Sends MP3 followup to Discord channel.

import { esc } from "./lib.mjs";
import { DEFAULT_TTS_VOICE } from "./core/runtime-defaults.mjs";

// maxChars 1500 ≈ 60–90 sec of speech at a normal neural-voice rate.
// A car listener doesn't want a 4-minute clip; the truncation cap
// keeps clips short enough to scan a reply in one breath. Override
// with the maxChars option if you need longer for, e.g., dictating
// an article aloud.
/** WHAT: Builds the bounded TTS controller. WHY: Keeps speech policy separate from Discord delivery. */
export function createTTS({ run, state, voice = DEFAULT_TTS_VOICE, maxChars = 1500 }) {
  const isEnabled = () => state.get("tts", false);

  const toggle = () => state.toggle("tts");

  async function sendFollowup(send, text, tmpFiles) {
    if (!isEnabled() || !text || text === "(empty response)") return;
    try {
      const clean = text.replace(/[`*_~|]/g, "").slice(0, maxChars);
      const ttsPath = `/tmp/discord-tts-${Date.now()}.mp3`;
      await run(`edge-tts --voice '${voice}' --text '${esc(clean)}' --write-media '${ttsPath}'`, 30000);
      tmpFiles.push(ttsPath);
      await send({ files: [ttsPath] });
    } catch {}
  }

  return { isEnabled, toggle, sendFollowup, voice };
}
