// Process message attachments: transcribe audio, download images/files.
// Channel-agnostic. Works with normalized ChannelMessage from channels/*.mjs.

import { writeFileSync } from "fs";
import { extname } from "path";
import { splitMessage } from "./lib.mjs";
import { downloadDiscordAttachment } from "./core/discord-attachment-download.mjs";
import { createPaneReplyReader, voiceContextEnv } from "./core/pane-latest-reply.mjs";
import { terminalVoiceOutcome } from "./core/voice-transcriber.mjs";

// No whitelist needed. All non-audio attachments are downloaded and passed
// to Claude, which can read most file types (PDF, images, text, archives, etc).

/** WHAT: Dates a transcript that arrives after the pane got a failure notice. WHY: The pane may already have answered the person, so it must see the text is old. */
function lateVoiceNote(msg) {
  if (!msg.voiceFailedEarlier || !msg.createdTimestamp) return "";
  const sent = new Date(Number(msg.createdTimestamp)).toISOString().slice(11, 16);
  return `; sent ${sent}Z, delivered late after a failed transcription, so it may already be handled`;
}

/**
 * Dependencies:
 *   run              - promisified exec(`cmd`, timeoutMs) → { stdout, stderr }
 *   transcribeScript - absolute path to a shell script that takes an audio
 *                      file path and prints transcribed text on stdout
 *   downloadBuffer   - async fn (url) → Buffer (injected so tests don't hit
 *                      the network; defaults live in index.mjs wiring)
 *   writeTmp         - optional override for writeFileSync, used only by tests
 *                      that don't want /tmp writes
 *   agentsYamlPath   - config that names each pane, for its latest reply
 *   paneReply        - (agent, pane) → latest reply; tests inject it
 * WHAT: Builds agent prompts from text, voice, images, and files.
 * WHY: Keeps platform attachment handling outside the message delivery path.
 */
export function createAttachmentHandler({
  run, transcribeScript, downloadBuffer, writeTmp = writeFileSync,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  agentsYamlPath = null, paneReply = agentsYamlPath ? createPaneReplyReader(agentsYamlPath) : null,
}) {

  const downloadAttachment = (att) =>
    downloadDiscordAttachment(att, { downloadBuffer, sleep });

  // One STT run per attachment: the ordered handler, and a REST scan that
  // re-prepares the message, join the run in flight instead of paying for a
  // second one. A run stays here until it settles (31 Oct 2026: two voice
  // notes were billed twice when a scan re-prepared them mid-transcription).
  const transcriptions = new Map();
  const transcriptionKey = (msg, att) => `${msg.channelId}:${msg.id}:${att.id}`;

  function trackTranscription(key, transcription) {
    transcriptions.set(key, transcription);
    // The ordered handler awaits this same promise and handles its failure.
    transcription.catch(() => {}).finally(() => {
      if (transcriptions.get(key) === transcription) transcriptions.delete(key);
    });
    return transcription;
  }

  /** WHAT: Starts STT for each journaled audio attachment once its bytes are durable. WHY: Keeps one hung transcription from delaying the next message's. */
  function transcribeAhead(msg) {
    for (const att of msg.attachments || []) {
      if (!att.contentType?.startsWith("audio/") || !att.durablePath) continue;
      const key = transcriptionKey(msg, att);
      if (transcriptions.has(key) || msg.getCachedTranscript?.(att.id)) continue;
      trackTranscription(key, transcribeAudio(msg, att, []));
    }
  }

  // The journal stores each note's target pane; the words that pane said last name its terms.
  function replyToVoice(msg) {
    const target = msg.resolvedTarget;
    return paneReply && target?.agentName && target.kind !== "inactive" ? paneReply(target.agentName, target.pane) : "";
  }

  function takeTranscription(msg, att, tmpFiles) {
    const key = transcriptionKey(msg, att);
    return transcriptions.get(key) || trackTranscription(key, transcribeAudio(msg, att, tmpFiles));
  }

  /** WHAT: Posts a readable Discord transcript in bounded chunks. WHY: Keeps long voice notes visible without markdown noise or 2000-character failures. */
  async function replyWithTranscript(msg, attachmentId, text, viaFallback) {
    const heading = viaFallback ? "**Transcript · Whisper fallback**" : "**Transcript**";
    const note = viaFallback
      ? "-# The main transcription was unavailable. Technical terms may be less accurate."
      : "-# Speech-to-text may contain errors.";
    const chunks = splitMessage(`${heading}\n${text}\n${note}`);
    if (typeof msg.sendTranscriptOnce === "function") {
      await msg.sendTranscriptOnce(attachmentId, chunks);
      return;
    }
    for (let i = 0; i < chunks.length; i++) {
      const send = i === 0 ? msg.reply.bind(msg) : msg.send.bind(msg);
      await send(chunks[i]).catch(() => {});
    }
  }

  /** WHAT: One audio attachment's line for the pane: its transcript, or its audio when the outcome is unknown; "" when a notice is all, null to stop.
   *  WHY: Keeps the voice rules in one place; they took five fixes in sixty days inside buildPrompt (agentmux churn, 10 Nov). */
  async function voiceLine(msg, att, tmpFiles) {
    let transcribed = await takeTranscription(msg, att, tmpFiles);
    if (msg.isInboundCompleted?.() || transcribed === null) return null;
    const terminal = terminalVoiceOutcome(transcribed);
    if (terminal) {
      const notice = terminal.code === "unknown" ? `${terminal.notice} The audio goes to the pane as a file.` : terminal.notice;
      if (typeof msg.sendTranscriptOnce === "function") {
        await msg.sendTranscriptOnce(att.id, [notice], { kind: "notice" });
      } else await msg.reply(notice);
      // An unknown outcome is never transcribed again, but the message still reaches its pane: the audio goes as a file
      // (10 Nov 21:55Z: Mattias's 57 s voice message to deep:0 was dropped here).
      if (terminal.code !== "unknown") return "";
      const path = await downloadToTmp(msg, att, tmpFiles);
      return path ? `[voice message not transcribed (outcome unknown); audio attached: ${path}]` : null;
    }
    // The wrapper marks fallback-engine transcripts (the primary failed →
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
      ? `[transcribed voice via whisper1 FALLBACK (primary transcription failed); extra error-prone on technical terms, interpret intent${lateVoiceNote(msg)}] ${transcribed}`
      : `[transcribed voice, may contain speech-to-text errors; interpret intent${lateVoiceNote(msg)}] ${transcribed}`;
    await replyWithTranscript(msg, att.id, transcribed, viaFallback);
    return tagged;
  }

  async function buildPrompt(msg, tmpFiles) {
    if (msg.isInboundCompleted?.()) return null;
    let rawText = msg.text.trim();

    for (const att of msg.attachments) {
      const isAudio = att.contentType?.startsWith("audio/");
      const isImage = att.contentType?.startsWith("image/");

      if (isAudio) {
        const line = await voiceLine(msg, att, tmpFiles);
        if (line === null) return null;
        if (line) rawText = rawText ? `${rawText}\n${line}` : line;
      } else {
        const path = await downloadToTmp(msg, att, tmpFiles);
        if (!path) return null;
        const label = isImage ? "image" : "file";
        rawText = rawText
          ? `${rawText}\n[${label} attached: ${path}]`
          : `[${label} attached: ${path}]`;
      }
    }

    return rawText || null;
  }

  async function transcribeAudio(msg, att, tmpFiles) {
    try {
      const cached = typeof msg.getCachedTranscript === "function"
        ? msg.getCachedTranscript(att.id)
        : null;
      if (typeof cached === "string" && cached) return cached;
      let tmpPath = att.durablePath || null;
      if (!tmpPath) {
        const buffer = await downloadAttachment(att);
        const ext = (att.name || "voice.ogg").split(".").pop();
        tmpPath = `/tmp/discord-voice-${msg.id}.${ext}`;
        writeTmp(tmpPath, buffer);
        tmpFiles.push(tmpPath);
      }
      // 300s covers the wrapper's full chain (gemini 2×100s + whisper1 60s).
      // The old 60s cap killed stalled-but-recoverable gemini calls and
      // surfaced them as a bare "Command failed" (2026-07-11, api:3: the
      // user's voice order was silently never delivered).
      const { stdout } = await run(`'${transcribeScript}' '${tmpPath}'`, 300000, voiceContextEnv(replyToVoice(msg)));
      if (msg.isInboundCompleted?.()) return null;
      const text = stdout.trim();
      if (!text) {
        msg.saveTranscript?.(att.id, "[stt:no_speech]");
        return "[stt:no_speech]";
      }
      if (typeof msg.saveTranscript === "function") msg.saveTranscript(att.id, text);
      // Reply with the tagged transcript is done by the caller (buildPrompt)
      // so the Discord reply and pane-bound text share one source of truth.
      return text;
    } catch (err) {
      // UNKNOWN was submitted, and can be billed. Cache its terminal outcome
      // with the existing transcript receipt so a REST scan cannot resend it.
      if ([22, 23].includes(Number(err.code))) {
        const terminal = Number(err.code) === 22 ? "[stt:unknown]" : "[stt:refused]";
        msg.saveTranscript?.(att.id, terminal);
        return terminal;
      }
      if (att.durablePath) {
        err.retryable = true;
        err.voiceFailure = { attachmentId: att.id, path: att.durablePath };
        throw err;
      }
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
      if (att.durablePath) return att.durablePath;
      const buffer = await downloadAttachment(att);
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

  return { buildPrompt, transcribeAhead };
}
