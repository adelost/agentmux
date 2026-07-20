import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * WHAT: Names the Swedish voice used when no explicit voice is requested.
 * WHY: Keeps CLI and tests aligned on one predictable default.
 */
export const DEFAULT_SPEECH_VOICE = "sv-SE-MattiasNeural";

/**
 * WHAT: Defines the maximum length of one spoken mobile update.
 * WHY: Keeps accidental long replies from becoming long audio broadcasts.
 */
export const MAX_SPEECH_CHARS = 1500;

/**
 * WHAT: Normalizes display text for short spoken output.
 * WHY: Keeps spoken output concise and free of Markdown punctuation.
 */
export function cleanSpeechText(text) {
  return String(text ?? "").replace(/[`*_~|]/g, "").trim().slice(0, MAX_SPEECH_CHARS);
}

/**
 * WHAT: Builds one temporary MP3 through an argv-only edge-tts process.
 * WHY: Keeps user-selected voices out of shell parsing and cleans partial files on failure.
 */
export function synthesizeSpeech(text, {
  voice = DEFAULT_SPEECH_VOICE,
  run = execFileSync,
  tempRoot = tmpdir(),
} = {}) {
  const clean = cleanSpeechText(text);
  if (!clean) throw new Error("speech text is empty after formatting");

  const selectedVoice = String(voice).trim();
  if (!selectedVoice) throw new Error("speech voice is empty");

  const tempDir = mkdtempSync(join(tempRoot, "amux-say-"));
  const mediaPath = join(tempDir, "speech.mp3");
  const cleanup = () => rmSync(tempDir, { recursive: true, force: true });

  try {
    run("edge-tts", [
      "--voice", selectedVoice,
      "--text", clean,
      "--write-media", mediaPath,
    ], {
      timeout: 30_000,
      stdio: ["ignore", "ignore", "pipe"],
    });
  } catch (error) {
    cleanup();
    throw new Error(`edge-tts failed: ${error.message}`, { cause: error });
  }

  return { clean, mediaPath, cleanup };
}
