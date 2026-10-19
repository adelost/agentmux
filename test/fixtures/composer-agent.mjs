// A pane composer behind the agent API, for tests of cancelled deliveries. Broker and withdrawal tests read this one
// fixture, so both sides of the seam see the same pane.
//
// The pane keeps the hazards of the real keys. Two Escapes clear a nonempty Claude draft, the same two on an empty
// composer open the rewind menu, and an Escape on a busy pane interrupts the turn. One Codex clear-line pass deletes
// one logical row. A refusal at the submit fence leaves the typed text where it is, as when the transport's erase
// keys fail ("typed command not erased").

const RULE = "─".repeat(84);

const blocked = (message) => Object.assign(new Error(message), { code: "AMUX_DELIVERY_BLOCKED" });

/**
 * Builds a pane and the agent API over it. `pane` is what a person would see: the composer text, the keys pressed,
 * the Enters, and whether a key did harm. `pane.afterPaste` runs between the paste and the submit fence.
 */
export function composerAgent({ dialect = "claude", composer = "", busy = false, pasting = false, hidden = false } = {}) {
  const pane = {
    dialect, composer, busy, pasting, hidden,
    captureFails: false, keysIgnored: false, afterPaste: null,
    typed: [], keys: [], enters: 0, submitted: [], observations: 0, wakeChecks: 0,
    rewindOpened: false, interrupted: false,
  };
  let escapePending = false;

  const press = (key) => {
    pane.keys.push(key);
    if (pane.busy) pane.interrupted = true;
    if (key !== "Escape") { escapePending = false; return; }
    if (!escapePending) { escapePending = true; return; }
    escapePending = false;
    if (pane.composer === "") pane.rewindOpened = true;
    else if (!pane.keysIgnored) pane.composer = "";
  };

  const screen = () => {
    if (pane.hidden) return ["Resume which session?", "  1. the most recent", "  2. an older one"].join("\n");
    const [first, ...rest] = pane.composer.split("\n");
    if (pane.dialect === "codex") {
      return ["• Earlier answer", `› ${first}`, ...rest.map((row) => `  ${row}`), "", "  gpt-6.1-sol high · ~/repo"].join("\n");
    }
    return [
      "● Earlier answer",
      ...(pane.busy ? ["✻ Working… (12s · esc to interrupt)"] : []),
      RULE, `❯ ${first}`, ...rest.map((row) => `  ${row}`), RULE,
      "  ⏵⏵ bypass permissions on (shift+tab to cycle)",
      ...(pane.pasting ? ["Pasting…"] : []),
    ].join("\n");
  };

  const readScreen = async () => {
    if (pane.captureFails) throw new Error("tmux capture failed");
    return screen();
  };

  const agent = {
    isBusy: async () => pane.busy,
    paneProcessState: async () => {
      pane.wakeChecks += 1;
      return { command: pane.dialect, dead: false, shell: false, running: true };
    },
    promptTransportState: async (_agentName, _pane, prompt) => {
      pane.observations += 1;
      const seen = { busy: pane.busy, dialect: pane.dialect };
      if (pane.pasting) return { state: "pasting", ...seen, detail: "Pasting…" };
      if (pane.hidden) return { state: "hidden", ...seen };
      if (/\[Pasted text #\d+/u.test(pane.composer)) {
        return { state: "foreign", ...seen, detail: "a collapsed paste amux cannot attribute" };
      }
      if (pane.composer && pane.composer.includes(prompt.trim().slice(0, 20))) return { state: "drafted", ...seen };
      if (pane.dialect === "codex") {
        return pane.composer
          ? { state: "foreign", ...seen, detail: pane.composer.slice(0, 60) }
          : { state: pane.busy ? "empty-busy" : "empty-idle", ...seen };
      }
      return { state: pane.busy ? "hidden" : "empty-idle", ...seen };
    },
    captureScreen: readScreen,
    capturePane: readScreen,
    sendEscape: async () => press("Escape"),
    clearInputLine: async () => {
      pane.keys.push("clear-line");
      escapePending = false;
      if (pane.busy) pane.interrupted = true;
      if (!pane.keysIgnored) pane.composer = pane.composer.split("\n").slice(0, -1).join("\n");
    },
    sendEnter: async () => {
      pane.enters += 1;
      pane.submitted.push(pane.composer);
      pane.composer = "";
    },
    dismissBlockingPrompt: async () => null,
    capturePromptEchoCursor: async () => ({ kind: "test", positions: {} }),
    waitForPromptEcho: async (_agentName, _pane, text) => pane.submitted.includes(text),
    sendOnly: async (_agentName, text, _pane, {
      knownDrafted = false, onPasteStarted = null, onDrafted = null, onSubmitting = null, onSubmitted = null,
    } = {}) => {
      if (!knownDrafted) {
        if (pane.composer) throw blocked("Claude prompt delivery blocked: the composer holds a draft amux did not type");
        pane.composer = text;
        pane.typed.push(text);
        if (pane.dialect === "codex") await onPasteStarted?.();
        await onDrafted?.();
        await pane.afterPaste?.();
      }
      await onSubmitting?.();
      await agent.sendEnter();
      await onSubmitted?.();
      return { submitted: true, queued: false };
    },
  };
  return { agent, pane };
}
