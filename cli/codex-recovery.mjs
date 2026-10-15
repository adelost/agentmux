import { createCodexCapacityRecovery } from "../core/codex-capacity-recovery.mjs";
import { createCodexLimitRecovery } from "../core/codex-limit-recovery.mjs";
import { DEFAULT_TMUX_SOCKET } from "../core/runtime-defaults.mjs";
import { createTmuxContext } from "./tmux.mjs";
import { codexAccountRequest, runRequestedCodexSwitch } from "./codex-account-switch.mjs";
import { refreshCodexRefusals } from "../core/codex-refusal-evidence.mjs";
import { selectedCodexProfile } from "../core/codex-profiles.mjs";

/** WHAT: Builds existing refusal recovery and explicit account requests. WHY: Keeps safe idle-boundary migration on the existing watcher, without another daemon or fabricated usage refusal. */
export function createCodexRecovery({ state, broker, agent, configPath, notify, log,
  requestedSwitch = runRequestedCodexSwitch, context = () => createTmuxContext(process.env.TMUX_SOCKET || DEFAULT_TMUX_SOCKET, configPath),
}) {
  const capacity = createCodexCapacityRecovery({ state, broker, agent, log });
  const limits = createCodexLimitRecovery({ state, broker, agent, notify, log });
  return {
    async tick(input) {
      await refreshCodexRefusals(input.result, selectedCodexProfile(state, input.name, input.pane).home);
      await capacity.tick(input);
      await limits.tick(input);
      const request = codexAccountRequest(state, input.name, input.pane);
      if (!input.idleBoundary || !broker?.queue || !request || !["pending", "switched"].includes(request.phase)) return;
      const ctx = { ...context(), agent, state, configPath, deliveryQueue: broker.queue };
      const result = await requestedSwitch(ctx, input.name, input.pane);
      if (result && result.status !== "pending") {
        log(`${result.key} explicit account ${request.target}: ${result.status}${result.reason ? ` (${result.reason})` : ""}`);
        if (result.status === "blocked") await notify(`Codex account switch ${result.key} stopped: ${result.reason}`,
          { name: input.name, pane: input.pane });
      }
    },
  };
}
