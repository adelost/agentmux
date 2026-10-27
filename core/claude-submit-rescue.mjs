// Claude composer rescue kept outside the legacy agent orchestrator.

import { isPromptInJsonl } from "./jsonl-reader.mjs";

/** WHAT: Builds Claude submit recovery. WHY: Keeps delayed paste handling separate from pane orchestration. */
export function createClaudeSubmitRescue({
  t,
  wait,
  paneDir,
  agentConfig,
  paneDialectName,
  isBusy,
  capturePane,
  holdsOwnPaste = async () => false,
}) {
  // echoCursor is the journal end fixed before the paste: only this send's bytes can prove it landed.
  return async function rescueClaudeSubmit(agentName, pane, target, prompt, { ownedPaste = null, echoCursor = null } = {}) {
    if (paneDialectName(agentName, pane) !== "claude") return;
    let dir;
    try { dir = paneDir(agentConfig(agentName).dir, pane); } catch { return; }
    const submitted = () => {
      try { return isPromptInJsonl(dir, prompt, { cursor: echoCursor }) === true; } catch { return false; }
    };
    await wait(750);
    if (submitted()) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await isBusy(agentName, pane)) return;
      const raw = await capturePane(agentName, pane, 15).catch(() => "");
      // Claude shows a multi-line paste as "[Pasted text #N +K lines]", which never contains the prompt's words.
      if (!raw.split("\n").slice(-5).join("\n").includes(prompt.trim().slice(0, 20))
          && !await holdsOwnPaste(agentName, pane, ownedPaste)) return;
      await t.sendEnter(target);
      await wait(750);
      if (submitted()) return;
    }
  };
}
