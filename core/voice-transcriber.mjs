import { randomBytes } from "node:crypto";
import { unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { esc } from "../lib.mjs";

export const TRANSCRIPT_PREFIX =
  "[transcribed voice, may contain speech-to-text errors; interpret intent]";

function withStatus(message, status) {
  return Object.assign(new Error(message), { status });
}

/**
 * WHAT: Transcribes one in-memory voice payload through the pinned local
 * transcriber. WHY: Phone PTT and public-mailbox PTT must share one audited
 * temporary-file, language, timeout, and error contract.
 */
export async function transcribeVoiceBuffer({
  audioBuffer,
  filename,
  language = "sv",
  run,
  transcribeScript,
  tempDir = "/tmp",
}) {
  const bytes = Buffer.from(audioBuffer || []);
  if (!bytes.length) throw withStatus("transcription empty; audio has no bytes", 422);
  if (typeof run !== "function" || !transcribeScript) {
    throw withStatus("transcription unavailable", 503);
  }
  const ext = String(filename || "voice.m4a")
    .split(".").pop().toLowerCase().replace(/[^a-z0-9]/g, "") || "m4a";
  const lang = String(language || "sv").toLowerCase().replace(/[^a-z]/g, "") || "sv";
  const tmpPath = join(tempDir, `agentmux-voice-${randomBytes(8).toString("hex")}.${ext}`);
  try {
    writeFileSync(tmpPath, bytes, { mode: 0o600 });
    const { stdout } = await run(
      `'${esc(transcribeScript)}' '${esc(tmpPath)}' '${esc(lang)}'`,
      60_000,
    );
    const transcript = String(stdout || "").trim();
    if (!transcript) {
      throw withStatus("transcription empty; audio may have been silent or unintelligible", 422);
    }
    return {
      text: `${TRANSCRIPT_PREFIX} ${transcript}`,
      transcript,
    };
  } catch (error) {
    if (error.status) throw error;
    throw withStatus(`transcription failed: ${error.message}`, 500);
  } finally {
    try { unlinkSync(tmpPath); } catch {}
  }
}

/** Adapts the shared result to the connector's buffer→text port. */
export function createVoiceBufferTranscriber(deps) {
  return async (audioBuffer, filename) => (
    await transcribeVoiceBuffer({ ...deps, audioBuffer, filename })
  ).text;
}
