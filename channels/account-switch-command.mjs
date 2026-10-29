// Discord `/byt <login|email>`: Mattias's own Claude account switch.
//
// `/byt wetterlind` shows the dry-run plan per pane and changes nothing.
// `/byt wetterlind ok`, from the operator, within ten minutes and while the
// plan is unchanged, runs the real rotation. Anything else shows the plan
// again. amux never switches by itself (Mattias 2026-10-10: "tänk dock på att
// inte byta i onödan.. pga cache miss").

import { resolveNotifyUserId } from "../cli/send-notify.mjs";
import { createTmuxContext } from "../cli/tmux.mjs";
import { DEFAULT_TMUX_SOCKET } from "../core/runtime-defaults.mjs";
import { withAccountEntries } from "../core/account-names.mjs";
import { accountEntries } from "../core/quota-profiles.mjs";
import { readClaudeProfileIdentity } from "../core/claude-account-quota.mjs";
import { resolveClaudeAccountTarget, runtimeProfileCatalog } from "../core/runtime-account-profiles.mjs";

/**
 * WHAT: Returns the context getter the bridge's account rotations run in, /byt and the quota stop mover.
 * WHY: Gives the switch plan tmux to list panes; without it every idle pane read as context-unknown.
 */
export function bridgeRotationRuntime({ agent, deliveryBroker, state, configPath,
  tmuxSocket = process.env.TMUX_SOCKET || DEFAULT_TMUX_SOCKET }, { createContext = createTmuxContext } = {}) {
  let context = null;
  return () => deliveryBroker?.queue && (context ||= {
    ...createContext(tmuxSocket, configPath), agent, deliveryQueue: deliveryBroker.queue, state, configPath,
  });
}

/** DTO: State key for the plans shown per target. */
export const SWITCH_PLAN_STATE_KEY = "account_switch_plans_v1";
/** DTO: How long a shown plan can be confirmed. */
export const SWITCH_CONFIRM_MAX_AGE_MS = 10 * 60_000;
const DISCORD_LIMIT = 1900;
// Slots and directory names can outlive their login; quota's account entries own the visible name.
const targetName = (target, env) => {
  const profile = resolveClaudeAccountTarget(target, runtimeProfileCatalog("claude", env));
  const account = profile ? readClaudeProfileIdentity(profile) : { email: target };
  return withAccountEntries([{ provider: "claude", profile, account }], accountEntries(env).entries)[0].name;
};

/** WHAT: Parses `/byt` arguments into target and confirm. WHY: Keeps a confirm explicit: exactly "<target> ok". */
export function parseSwitchArgs(args) {
  const words = String(args || "").trim().split(/\s+/u).filter(Boolean);
  if (words.length === 1) return { target: words[0], confirm: false };
  if (words.length === 2 && words[1].toLowerCase() === "ok") return { target: words[0], confirm: true };
  return null;
}

/** WHAT: Encodes a rotation result as each pane's verdict. WHY: Keeps a confirm bound to the plan Mattias saw, not to token counts that drift. */
export const planSignature = (result) => JSON.stringify([result?.status || null,
  ...(result?.rows || []).map((row) => `${row.key}=${row.status || row.mode}`).sort()]);

const fenced = (lines) => {
  const body = lines.join("\n");
  return `\`\`\`\n${body.length > DISCORD_LIMIT - 200 ? `${body.slice(0, DISCORD_LIMIT - 220)}\n…` : body}\n\`\`\``;
};

const planReply = (target, plan, lead) => {
  const usable = plan.result?.status !== "BLOCKED" || plan.result?.rows?.length;
  return [lead, fenced(plan.lines), usable
    ? `Nothing has changed. Switch with \`/byt ${target} ok\` within 10 min. Panes marked blocked are not touched.`
    : "Nothing has changed, and that account cannot be switched to right now."].join("\n");
};

/**
 * WHAT: Builds the `/byt` handler over the fleet rotation.
 * WHY: Keeps a Discord switch from moving any pane before Mattias has seen and confirmed its plan.
 */
export function createAccountSwitchCommand({
  runtime, state, env = process.env,
  rotate = async (...args) => (await import("../cli/account-rotation.mjs")).rotateClaudeFleet(...args),
  operatorId = () => resolveNotifyUserId(),
  now = Date.now, maxAgeMs = SWITCH_CONFIRM_MAX_AGE_MS,
}) {
  const run = async (target, dry) => {
    const lines = [];
    const result = await rotate(runtime(), target, { dry },
      { output: (line) => lines.push(line), setExitCode: () => {} });
    return { result, lines };
  };
  const plans = () => state.get(SWITCH_PLAN_STATE_KEY, {}) || {};
  const remember = (key, plan) => state.set(SWITCH_PLAN_STATE_KEY,
    { ...plans(), [key]: { signature: planSignature(plan.result), at: now() } });
  const forget = (key) => {
    const { [key]: _done, ...rest } = plans();
    state.set(SWITCH_PLAN_STATE_KEY, rest);
  };

  return async (msg, _mapping, _pane, args) => {
    const parsed = parseSwitchArgs(args);
    if (!parsed) {
      await msg.reply("Use `/byt <login|email>`, for example `/byt wetterlind`. It shows the plan per pane and changes nothing.");
      return;
    }
    const { target, confirm } = parsed;
    const key = target.toLowerCase();
    if (!runtime()) {
      await msg.reply("An account switch needs the bridge's delivery queue, and it is not running here.");
      return;
    }
    if (confirm && (!operatorId() || String(msg.authorId) !== String(operatorId()))) {
      await msg.reply("Only the operator can confirm an account switch.");
      return;
    }
    const plan = await run(target, true);
    const pending = plans()[key];
    if (!confirm || !pending || now() - pending.at > maxAgeMs || pending.signature !== planSignature(plan.result)) {
      const lead = !confirm ? `Plan to switch to **${targetName(target, env)}**:`
        : !pending || now() - pending.at > maxAgeMs ? "The plan was not shown in the last 10 minutes. Here it is now:"
          : "The plan has changed since you saw it. Here is the new one:";
      remember(key, plan);
      await msg.reply(planReply(target, plan, lead));
      return;
    }
    forget(key);
    await msg.reply(`Switching to **${targetName(target, env)}** now. Large active panes are compacted first.`);
    const done = await run(target, false);
    await msg.reply([`Result of the switch to **${targetName(target, env)}**:`, fenced(done.lines)].join("\n"));
  };
}
