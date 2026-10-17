// A resumed Claude TUI can be idle while its pre-crash journal still owes a tool reply.
import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { CLAUDE, composerDraft } from "./dialects.mjs";
import { findBlockingPrompt, hasEmptyClaudeComposer } from "./dismiss.mjs";
import { claudePasteTransportState } from "./claude-composer-guards.mjs";
import { latestClaudeSessionIdentity } from "./native-session-identity.mjs";
import { parseJsonlWindow } from "./jsonl-reader.mjs";
import { parseBootMs } from "./revive.mjs";

function interruptedJournal(dir, procRoot) {
  const bootMs = parseBootMs(readFileSync(join(procRoot, "stat"), "utf8"));
  if (!Number.isFinite(bootMs)) return null;
  const identity = latestClaudeSessionIdentity(dir);
  if (!identity) return null;
  const stat = statSync(identity.path);
  const activity = parseJsonlWindow(identity.path).filter(event =>
    ["user", "assistant", "progress", "queue-operation"].includes(event.type));
  if (!activity.length || activity.some(event => {
    const at = Date.parse(event.timestamp);
    return !Number.isFinite(at) || at >= bootMs;
  })) return null;
  return `${identity.sessionId}:${stat.size}:${stat.mtimeMs}:${bootMs}`;
}

function emptyLiveComposer(screen) {
  return hasEmptyClaudeComposer(screen) && composerDraft(screen) === ""
    && !findBlockingPrompt(screen) && !claudePasteTransportState(screen)
    && !CLAUDE.busySignals.some(signal => typeof signal === "string" ? screen.includes(signal) : signal.test(screen));
}

/** WHAT: Checks a pre-boot busy journal against two live empty observations. WHY: Lets compact and delivery recover without treating a current turn, draft or paste as idle. */
export async function rebootedClaudeIsIdle({ dir, procRoot = "/proc", capture, wait }) {
  try {
    const before = interruptedJournal(dir, procRoot);
    if (!before || !emptyLiveComposer(await capture())) return false;
    await wait(100);
    return emptyLiveComposer(await capture()) && interruptedJournal(dir, procRoot) === before;
  } catch {
    // Missing boot, journal or live evidence retains the existing busy guard.
    return false;
  }
}
