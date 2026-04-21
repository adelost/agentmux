// Process message attachments: transcribe audio, download images/files.
// Channel-agnostic. Works with normalized ChannelMessage from channels/*.mjs.

import { writeFileSync } from "fs";
import { extname } from "path";

// No whitelist needed. All non-audio attachments are downloaded and passed
// to Claude, which can read most file types (PDF, images, text, archives, etc).

/**
 * Dependencies:
 *   run              - promisified exec(`cmd`, timeoutMs) → { stdout, stderr }
 *   transcribeScript - absolute path to a shell script that takes an audio
 *                      file path and prints transcribed text on stdout
 *   downloadBuffer   - async fn (url) → Buffer (injected so tests don't hit
 *                      the network; defaults live in index.mjs wiring)
 *   writeTmp         - optional override for writeFileSync, used only by tests
 *                      that don't want /tmp writes
 */
export function createAttachmentHandler({ run, transcribeScript, downloadBuffer, writeTmp = writeFileSync }) {

  async function buildPrompt(msg, tmpFiles) {
    let rawText = msg.text.trim();

    for (const att of msg.attachments) {
      const isAudio = att.contentType?.startsWith("audio/");
      const isImage = att.contentType?.startsWith("image/");

      if (isAudio) {
        const transcribed = await transcribeAudio(msg, att, tmpFiles);
        if (transcribed === null) return null;
        // Same disclaimer in both destinations: the agent (via pane text)
        // and the Discord reply. The "interpret intent" hint is as useful
        // for the human reading the reply as it is for the agent reading
        // the prompt — anyone seeing it knows this is AI-transcribed and
        // may have word-level errors.
        const tagged = `[transcribed voice, may contain speech-to-text errors — interpret intent] ${transcribed}`;
        await msg.reply(`*${tagged}*`).catch(() => {});
        if (!rawText) rawText = tagged;
        else rawText = `${rawText}\n${tagged}`;
      } else {
        const path = await downloadToTmp(msg, att, tmpFiles);
        if (path) {
          const label = isImage ? "image" : "file";
          rawText = rawText
            ? `${rawText}\n[${label} attached: ${path}]`
            : `[${label} attached: ${path}]`;
        }
      }
    }

    return rawText || null;
  }

  async function transcribeAudio(msg, att, tmpFiles) {
    try {
      const buffer = await downloadBuffer(att.url);
      const ext = (att.name || "voice.ogg").split(".").pop();
      const tmpPath = `/tmp/discord-voice-${msg.id}.${ext}`;
      writeTmp(tmpPath, buffer);
      tmpFiles.push(tmpPath);
      const { stdout } = await run(`'${transcribeScript}' '${tmpPath}'`, 60000);
      const text = stdout.trim();
      if (!text) {
        await msg.reply("*(could not transcribe voice message)*");
        return null;
      }
      // Reply with the tagged transcript is done by the caller (buildPrompt)
      // so the Discord reply and pane-bound text share one source of truth.
      return text;
    } catch (err) {
      await msg.reply(`Transcription failed: ${err.message}`).catch(() => {});
      return null;
    }
  }

  async function downloadToTmp(msg, att, tmpFiles) {
    try {
      const buffer = await downloadBuffer(att.url);
      const ext = extname(att.name || ".bin") || ".bin";
      const tmpPath = `/tmp/discord-media-${msg.id}-${att.id}${ext}`;
      writeTmp(tmpPath, buffer);
      tmpFiles.push(tmpPath);
      return tmpPath;
    } catch (err) {
      await msg.reply(`Failed to download ${att.name}: ${err.message}`).catch(() => {});
      return null;
    }
  }

  return { buildPrompt };
}
