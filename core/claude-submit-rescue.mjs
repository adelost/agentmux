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
}) {
  return async function rescueClaudeSubmit(agentName, pane, target, prompt) {
    if (paneDialectName(agentName, pane) !== "claude") return;
    let dir;
    try { dir = paneDir(agentConfig(agentName).dir, pane); } catch { return; }
    const submitted = () => {
      try { return isPromptInJsonl(dir, prompt) === true; } catch { return false; }
    };
    await wait(750);
    if (submitted()) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await isBusy(agentName, pane)) return;
      const raw = await capturePane(agentName, pane, 15).catch(() => "");
      if (!raw.split("\n").slice(-5).join("\n").includes(prompt.trim().slice(0, 20))) return;
      await t.sendEnter(target);
      await wait(750);
      if (submitted()) return;
    }
  };
}
