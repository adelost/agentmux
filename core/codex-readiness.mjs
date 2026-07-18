import { findBlockingPrompt } from "./dismiss.mjs";
import { codexComposerText, isCodexFullscreenPager } from "./codex-tui.mjs";
import { waitForProgressingUi } from "./progressing-ui.mjs";

/**
 * WHAT: Returns readiness from a progressing Codex TUI.
 * WHY: Prevents slow session replay from becoming a false startup failure.
 */
export async function waitForCodexUiReady({
  tmux,
  target,
  agentName,
  pane,
  delay,
  hardTimeoutMs = 120_000,
  now = Date.now,
  logger = console,
}) {
  let nextRevealAt = now() + 2500;
  let reveals = 0;
  const ready = await waitForProgressingUi({
    capture: () => tmux.captureScreen(target),
    inspect: async (content) => {
      const blocker = findBlockingPrompt(content);
      if (blocker) {
        await tmux.sendKeys(target, blocker.keys);
        return { waitMs: blocker.waitMs };
      }
      if (isCodexFullscreenPager(content)) {
        await tmux.sendLiteral(target, "q").catch(() => {});
        return { waitMs: 300 };
      }
      if (codexComposerText(content) === "") return true;
      if (now() >= nextRevealAt && reveals < 3) {
        await tmux.sendEscape(target).catch(() => {});
        reveals++;
        nextRevealAt = now() + 2500;
      }
      return false;
    },
    delay,
    now,
    hardTimeoutMs,
  });
  if (!ready) logger.warn(`waitForCodexUiReady(${agentName}:${pane}) stalled before ${hardTimeoutMs}ms`);
  return ready;
}
