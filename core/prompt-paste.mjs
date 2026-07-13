import { randomUUID } from "crypto";
import { unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Multiline input can paint one line at a time in a busy TUI. Paste it as one payload. */
export function promptRequiresAtomicPaste(prompt) {
  const text = String(prompt || "");
  return text.length > 500 || /[\r\n]/.test(text);
}

/**
 * Paste one prompt through an isolated file and one-shot tmux buffer.
 * Unique identities prevent concurrent sends in the bridge from crossing
 * payloads. Cleanup runs on both successful and failed tmux calls.
 */
export async function pastePrompt({ tmux, target, prompt, sleep, log = console.warn }) {
  const token = randomUUID();
  const payloadPath = join(tmpdir(), `agentmux-prompt-${token}.txt`);
  const buffer = `prompt_${token}`;
  writeFileSync(payloadPath, prompt);
  try {
    await tmux.loadBuffer(buffer, payloadPath);
    await tmux.pasteBuffer(buffer, target);
  } finally {
    try {
      unlinkSync(payloadPath);
    } catch (error) {
      if (error?.code !== "ENOENT") log(`pastePrompt: cleanup ${payloadPath} failed: ${error.message}`);
    }
  }
  await sleep(250);
}
