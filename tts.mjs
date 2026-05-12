// TTS: text-to-speech via edge-tts. Sends MP3 followup to Discord channel.

import { esc } from "./lib.mjs";

// maxChars 1500 ≈ 60–90 sec of speech at the default Swedish voice rate.
// A car listener doesn't want a 4-minute clip; the truncation cap
// keeps clips short enough to scan a reply in one breath. Override
// with the maxChars option if you need longer for, e.g., dictating
// an article aloud.
export function createTTS({ run, state, voice = "sv-SE-SofieNeural", maxChars = 1500 }) {
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
