// Process message attachments: transcribe audio, download images/files.
// Channel-agnostic — works with normalized ChannelMessage from channels/*.mjs.

import { writeFileSync } from "fs";
import { extname } from "path";
import { downloadBuffer } from "./lib.mjs";

const TEXT_EXTENSIONS =
  /\.(txt|md|json|yaml|yml|csv|xml|log|ts|js|py|sh|html|css|toml|ini|cfg|env)$/i;

export function createAttachmentHandler({ run, transcribeScript }) {

  async function buildPrompt(msg, tmpFiles) {
    let rawText = msg.text.trim();

    for (const att of msg.attachments) {
      const isAudio = att.contentType?.startsWith("audio/");
      const isImage = att.contentType?.startsWith("image/");
      const isText = att.contentType?.startsWith("text/") ||
        TEXT_EXTENSIONS.test(att.name || "");

      if (isAudio) {
        const transcribed = await transcribeAudio(msg, att, tmpFiles);
        if (transcribed === null) return null;
        const tagged = `[transcribed voice, may contain speech-to-text errors — interpret intent] ${transcribed}`;
        if (!rawText) rawText = tagged;
        else rawText = `${rawText}\n${tagged}`;
      } else if (isImage || isText) {
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
      writeFileSync(tmpPath, buffer);
      tmpFiles.push(tmpPath);
      const { stdout } = await run(`'${transcribeScript}' '${tmpPath}'`, 60000);
      const text = stdout.trim();
      if (!text) {
        await msg.reply("*(could not transcribe voice message)*");
        return null;
      }
      await msg.reply(`*[transcribed voice] ${text}*`);
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
      writeFileSync(tmpPath, buffer);
      tmpFiles.push(tmpPath);
      return tmpPath;
    } catch (err) {
      await msg.reply(`Failed to download ${att.name}: ${err.message}`).catch(() => {});
      return null;
    }
  }

  return { buildPrompt };
}
