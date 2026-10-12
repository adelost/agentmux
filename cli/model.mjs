import { parseFlags } from "./command-args.mjs";
import { join } from "node:path";
import { getAgent } from "./config.mjs";
import { normalizeClaudeModelName } from "../core/claude-model.mjs";
import { runLockedClaudeModelChange } from "../core/claude-model-command.mjs";
import { codexModelRequest, formatCodexModelChange, formatCodexModelFailure, runLockedCodexModelChange } from "../core/codex-model-command.mjs";
import { driveCodexStatus } from "../core/codex-status.mjs";
import { readParkState, unparkPane } from "../core/pane-park.mjs";
import { startFreshCodexSession } from "../core/codex-fresh-session.mjs";

/** WHAT: Routes a CLI model selection through exact compact and native verification. WHY: Keeps automation from bypassing the Discord model-change cost boundary. */
export async function cmdModel(args, ctx, { claudeModelChanger = runLockedClaudeModelChange,
  codexModelChanger = runLockedCodexModelChange, codexModels, freshCodexStarter = startFreshCodexSession } = {}) {
  const { flags, positional } = parseFlags(args, { p: "number", help: "boolean", "new-session": "boolean" });
  if (flags.help) {
    console.log("Usage: amux model AGENT [-p N] MODEL [EFFORT] [--new-session]\nOrdinary changes verify exact-session compact. --new-session starts sol xhigh on a stopped pane, preserves the old journal and does not replay old prompts.");
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
  if (!/^[a-z0-9._-]+$/i.test(model || "") || (effort && !/^(minimal|low|medium|high|xhigh|max|ultra)$/.test(effort))) {
    throw new Error("Expected a model name and optional reasoning effort");
  }
  const { ok, model: targetModel, reason } = await codexModelRequest({ state: ctx.state, name, pane, requested: model, models: codexModels });
  if (!ok) throw new Error(`${reason}. ${name}:${pane} keeps its current model.`);
  if (flags["new-session"]) {
    const result = await freshCodexStarter({ agent: ctx.agent, state: ctx.state, queue: ctx.deliveryQueue,
      name, pane, targetModel, targetEffort: effort });
    console.log(`${name}:${pane} now runs ${result.model} ${result.effort} in new session ${result.sessionId}. The old journal is preserved.`);
    return;
  }
  const result = await codexModelChanger({ agent: ctx.agent, state: ctx.state, name, pane,
    targetModel, targetEffort: effort, deliveryBroker: { queue: ctx.deliveryQueue }, statusDriver: driveCodexStatus });
  if (!result.ok) throw new Error(formatCodexModelFailure(name, pane, result));
  unparkPane({ session: name, pane, detail: `explicit verified model selection: ${result.model}` });
  console.log(formatCodexModelChange(name, pane, result));
}
