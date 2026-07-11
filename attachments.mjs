// Process message attachments: transcribe audio, download images/files.
// Channel-agnostic. Works with normalized ChannelMessage from channels/*.mjs.

import { writeFileSync } from "fs";
import { extname } from "path";
import { splitMessage } from "./lib.mjs";

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
 * WHAT: Builds agent prompts from text, voice, images, and files.
 * WHY: Keeps platform attachment handling outside the message delivery path.
 */
export function createAttachmentHandler({ run, transcribeScript, downloadBuffer, writeTmp = writeFileSync }) {

  /** WHAT: Posts a readable Discord transcript in bounded chunks. WHY: Keeps long voice notes visible without markdown noise or 2000-character failures. */
  async function replyWithTranscript(msg, text, viaFallback) {
    const heading = viaFallback ? "**Transcript · Whisper fallback**" : "**Transcript**";
    const note = viaFallback
      ? "-# Gemini was unavailable. Technical terms may be less accurate."
      : "-# Speech-to-text may contain errors.";
    const chunks = splitMessage(`${heading}\n${text}\n${note}`);
    for (let i = 0; i < chunks.length; i++) {
      const send = i === 0 ? msg.reply.bind(msg) : msg.send.bind(msg);
      await send(chunks[i]).catch(() => {});
    }
  }

  async function buildPrompt(msg, tmpFiles) {
    let rawText = msg.text.trim();

    for (const att of msg.attachments) {
      const isAudio = att.contentType?.startsWith("audio/");
      const isImage = att.contentType?.startsWith("image/");

      if (isAudio) {
        let transcribed = await transcribeAudio(msg, att, tmpFiles);
        if (transcribed === null) return null;
        // The wrapper marks fallback-engine transcripts (gemini failed →
        // whisper1 took over). The mark must survive into BOTH destinations:
        // whisper1 mishears technical terms, and a silent fallback would be
        // a quality downgrade nobody knows to compensate for.
        const FALLBACK_MARK = "[stt-fallback:whisper1] ";
        const viaFallback = transcribed.startsWith(FALLBACK_MARK);
        if (viaFallback) transcribed = transcribed.slice(FALLBACK_MARK.length).trim();
        // Same disclaimer in both destinations: the agent (via pane text)
        // and the Discord reply. The "interpret intent" hint is as useful
        // for the human reading the reply as it is for the agent reading
        // the prompt — anyone seeing it knows this is AI-transcribed and
        // may have word-level errors.
        const tagged = viaFallback
          ? `[transcribed voice via whisper1 FALLBACK (gemini failed) — extra error-prone on technical terms, interpret intent] ${transcribed}`
          : `[transcribed voice, may contain speech-to-text errors — interpret intent] ${transcribed}`;
        await replyWithTranscript(msg, transcribed, viaFallback);
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
      // 300s covers the wrapper's full chain (gemini 2×100s + whisper1 60s).
      // The old 60s cap killed stalled-but-recoverable gemini calls and
      // surfaced them as a bare "Command failed" (2026-07-11, api:3: the
      // user's voice order was silently never delivered).
      const { stdout } = await run(`'${transcribeScript}' '${tmpPath}'`, 300000);
      const text = stdout.trim();
      if (!text) {
        await msg.reply("*(could not transcribe voice message)*");
        return null;
      }
      // Reply with the tagged transcript is done by the caller (buildPrompt)
      // so the Discord reply and pane-bound text share one source of truth.
      return text;
    } catch (err) {
      // exec's message is just "Command failed: <cmd>" — the actionable
      // cause lives in stderr. Surface its tail so the user sees WHY.
      const cause = String(err.stderr || "").trim().split("\n").slice(-2).join(" | ");
      const timedOut = err.killed ? " (timeout)" : "";
      await msg.reply(`Transcription failed${timedOut}: ${err.message}${cause ? `\n└ ${cause}` : ""}`).catch(() => {});
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
