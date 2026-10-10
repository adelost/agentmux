import { randomUUID } from "crypto";
import { unlinkSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

/** Multiline input can paint one line at a time in a busy TUI. Paste it as one payload. */
export function promptRequiresAtomicPaste(prompt) {
  const text = String(prompt || "");
  return text.length > 500 || /[\r\n]/.test(text);
}

// A Claude paste in parts (core/claude-paste-stall.mjs): the pause lets Claude insert one part before the next.
const PART_GAP_MS = 100;

/**
 * WHAT: Routes one prompt, in the given parts, through isolated files and one-shot tmux buffers.
 * WHY: Keeps concurrent bridge sends from crossing payloads; cleanup runs on success and failure.
 */
export async function pastePrompt({ tmux, target, prompt, sleep, log = console.warn, parts = [prompt] }) {
  for (const [index, part] of parts.entries()) {
    if (index) await sleep(PART_GAP_MS);
    const token = randomUUID();
    const payloadPath = join(tmpdir(), `agentmux-prompt-${token}.txt`);
    const buffer = `prompt_${token}`;
    writeFileSync(payloadPath, part);
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
  }
  await sleep(250);
}
