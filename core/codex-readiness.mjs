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
  hardTimeoutMs = 180_000,
  stallTimeoutMs = 150_000,
  now = Date.now,
  logger = console,
}) {
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
      // Unknown startup screens are not neutral composers. Escape can quit a
      // trust dialog or cancel replay, so only recognized menus receive keys.
      return false;
    },
    delay,
    now,
    hardTimeoutMs,
    stallTimeoutMs,
  });
  if (!ready) {
    logger.warn(
      `waitForCodexUiReady(${agentName}:${pane}) not ready within startup bounds `
      + `(hard ${hardTimeoutMs}ms, static ${stallTimeoutMs}ms)`,
    );
  }
  return ready;
}
