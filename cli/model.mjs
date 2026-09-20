import { parseFlags } from "./command-args.mjs";
import { getAgent } from "./config.mjs";
import { resolveCodexModelName } from "../core/codex-profiles.mjs";
import { runLockedCodexModelChange } from "../core/codex-model-command.mjs";
import { driveCodexStatus } from "../core/codex-status.mjs";
import { unparkPane } from "../core/pane-park.mjs";

/** WHAT: Routes a CLI model selection through exact compact and native verification. WHY: Keeps automation from bypassing the Discord model-change cost boundary. */
export async function cmdModel(args, ctx) {
  const { flags, positional } = parseFlags(args, { p: "number", help: "boolean" });
  if (flags.help) {
    console.log("Usage: amux model AGENT [-p N] MODEL [EFFORT]\nCompacts the exact Codex session before changing model; failed compact blocks work.");
    return;
  }
  const [name, model, effort] = positional, pane = flags.p ?? 0;
  const entry = getAgent(ctx.configPath, name);
  if (!/\bcodex\b/.test(entry.panes?.[pane]?.cmd || "")) throw new Error("amux model requires a configured Codex pane");
  const targetModel = resolveCodexModelName(model);
  if (!/^[a-z0-9._-]+$/i.test(targetModel) || (effort && !/^(minimal|low|medium|high|xhigh|max|ultra)$/.test(effort))) {
    throw new Error("Expected a model name and optional reasoning effort");
  }
  const result = await runLockedCodexModelChange({ agent: ctx.agent, state: ctx.state, name, pane,
    targetModel, targetEffort: effort, deliveryBroker: { queue: ctx.deliveryQueue }, statusDriver: driveCodexStatus });
  if (!result.ok) throw new Error(`model change blocked: ${result.error || result.reason || result.stage}`);
  unparkPane({ session: name, pane, detail: `explicit verified model selection: ${result.model}` });
  console.log(`${name}:${pane}: compact verified; selected ${result.model} ${result.effort || ""}`.trim());
}
