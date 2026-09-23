import { parseFlags } from "./command-args.mjs";
import { join } from "node:path";
import { getAgent } from "./config.mjs";
import { normalizeClaudeModelName } from "../core/claude-model.mjs";
import { runLockedClaudeModelChange } from "../core/claude-model-command.mjs";
import { resolveCodexModelName } from "../core/codex-profiles.mjs";
import { formatCodexModelChange, runLockedCodexModelChange } from "../core/codex-model-command.mjs";
import { driveCodexStatus } from "../core/codex-status.mjs";
import { readParkState, unparkPane } from "../core/pane-park.mjs";

/** WHAT: Routes a CLI model selection through exact compact and native verification. WHY: Keeps automation from bypassing the Discord model-change cost boundary. */
export async function cmdModel(args, ctx, { claudeModelChanger = runLockedClaudeModelChange } = {}) {
  const { flags, positional } = parseFlags(args, { p: "number", help: "boolean" });
  if (flags.help) {
    console.log("Usage: amux model AGENT [-p N] MODEL [EFFORT]\nVerifies the current model and exact-session compact receipt; compacts only when a change needs new proof.");
    return;
  }
  const [name, model, effort] = positional, pane = flags.p ?? 0;
  const entry = getAgent(ctx.configPath, name);
  if (/\bclaude\b/u.test(entry.panes?.[pane]?.cmd || "")) {
    if (effort) throw new Error("Claude model change keeps the current effort; omit EFFORT");
    const requested = normalizeClaudeModelName(model);
    if (!requested.ok) throw new Error(`invalid Claude model: ${requested.reason}`);
    const result = await claudeModelChanger({ agent: ctx.agent, state: ctx.state,
      queue: ctx.deliveryQueue, name, pane, paneDir: join(entry.dir, ".agents", String(pane)),
      targetModel: requested.model });
    if (!result.ok) throw new Error(`model change blocked: ${result.reason || result.stage}`);
    if (readParkState(name, pane)) unparkPane({ session: name, pane, detail: `verified Claude model: ${result.model}` });
    console.log(result.unchanged ? `${name}:${pane}: already using ${result.model}; no compact`
      : `${name}:${pane}: compact verified; selected ${result.model}; effort unchanged`);
    return;
  }
  if (!/\bcodex\b/.test(entry.panes?.[pane]?.cmd || "")) throw new Error("amux model requires a configured Codex pane");
  const targetModel = resolveCodexModelName(model);
  if (!/^[a-z0-9._-]+$/i.test(targetModel) || (effort && !/^(minimal|low|medium|high|xhigh|max|ultra)$/.test(effort))) {
    throw new Error("Expected a model name and optional reasoning effort");
  }
  const result = await runLockedCodexModelChange({ agent: ctx.agent, state: ctx.state, name, pane,
    targetModel, targetEffort: effort, deliveryBroker: { queue: ctx.deliveryQueue }, statusDriver: driveCodexStatus });
  if (!result.ok) throw new Error(`model change blocked: ${result.error || result.reason || result.stage}`);
  unparkPane({ session: name, pane, detail: `explicit verified model selection: ${result.model}` });
  console.log(formatCodexModelChange(name, pane, result));
}
