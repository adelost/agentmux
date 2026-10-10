// Discord `/byt <login|email>`: Mattias's own Claude account switch.
//
// `/byt wetterlind` shows the dry-run plan per pane and changes nothing.
// `/byt wetterlind ok`, from the operator, within ten minutes and while the
// plan is unchanged, runs the real rotation. Anything else shows the plan
// again. amux never switches by itself (Mattias 2026-10-10: "tänk dock på att
// inte byta i onödan.. pga cache miss").

import { resolveNotifyUserId } from "../cli/send-notify.mjs";

/** DTO: State key for the plans shown per target. */
export const SWITCH_PLAN_STATE_KEY = "account_switch_plans_v1";
/** DTO: How long a shown plan can be confirmed. */
export const SWITCH_CONFIRM_MAX_AGE_MS = 10 * 60_000;
const DISCORD_LIMIT = 1900;

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
    ? `Inget är ändrat. Byt med \`/byt ${target} ok\` inom 10 min. Paneler som står blocked rörs inte.`
    : "Inget är ändrat, och det går inte att byta till det kontot just nu."].join("\n");
};

/**
 * WHAT: Builds the `/byt` handler over the fleet rotation.
 * WHY: Keeps a Discord switch from moving any pane before Mattias has seen and confirmed its plan.
 */
export function createAccountSwitchCommand({
  runtime, state,
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
      await msg.reply("Använd `/byt <login|e-post>`, till exempel `/byt wetterlind`. Den visar planen per panel och ändrar inget.");
      return;
    }
    const { target, confirm } = parsed;
    const key = target.toLowerCase();
    if (!runtime()) {
      await msg.reply("Kontobyte kräver bryggans leveranskö, och den är inte igång här.");
      return;
    }
    if (confirm && (!operatorId() || String(msg.authorId) !== String(operatorId()))) {
      await msg.reply("Bara operatören kan bekräfta ett kontobyte.");
      return;
    }
    const plan = await run(target, true);
    const pending = plans()[key];
    if (!confirm || !pending || now() - pending.at > maxAgeMs || pending.signature !== planSignature(plan.result)) {
      const lead = !confirm ? `Plan för byte till **${target}**:`
        : !pending || now() - pending.at > maxAgeMs ? "Planen var inte visad de senaste 10 minuterna. Här är den nu:"
          : "Planen har ändrats sedan du såg den. Här är den nya:";
      remember(key, plan);
      await msg.reply(planReply(target, plan, lead));
      return;
    }
    forget(key);
    await msg.reply(`Byter till **${target}** nu. Stora aktiva paneler får compact först.`);
    const done = await run(target, false);
    await msg.reply([`Resultat för byte till **${target}**:`, fenced(done.lines)].join("\n"));
  };
}
