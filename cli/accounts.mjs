// Small operator CLI for coding-subscription profiles.
//
// It never prints tokens and never changes a running pane implicitly. Login
// commands are provider-scoped; Codex pane switching remains the existing
// explicit /switch flow with continuity checks.

import { quotaBoxText } from "../channels/quota-warning.mjs";
import { formatQuotaSnapshot } from "../core/quota-format.mjs";
import { creditStopText, readCreditStopWeek } from "../core/codex-credit-log.mjs";
import { newClaudeLoginProfile, profileLoginInstruction, quotaAccountCatalog, quotaProfile } from "../core/quota-profiles.mjs";
import { readQuotaSnapshotWithPanes } from "../core/quota-in-use.mjs";
import { prepareRuntimeProfile, resolveClaudeAccountTarget } from "../core/runtime-account-profiles.mjs";
import { readClaudeProfileIdentity } from "../core/claude-account-quota.mjs";
import { rotateClaudeFleet } from "./account-rotation.mjs";
import { switchStatusCommand } from "./codex-account-status.mjs";
import { switchCodexAccounts } from "./codex-account-switch.mjs";

const usage = `Usage:
  amux accounts                                  same view as amux quota
  amux accounts login <codex|kimi>:<1|2>
  amux accounts login claude:<1|2|login|email>   a new login name gets its own dir
  amux accounts rotate claude:<1|2|login|email> [--dry]
  amux accounts switch codex:<1|2> PROJECT [-p N] [--dry] [--continue-file PATH]
  amux accounts switch codex:<1|2> --all [--dry] [--json] [--request-id ID]
  amux accounts switch-status [--json] [--request-id ID]
  amux quota [--all] [--json]

Login dirs: ~/.config/agent/account-profiles/claude/<login>, one account per dir.
~/.agentmux/account-profiles.json version 2 holds one entry per login, filled in by hand from the billing pages:
  "accounts": {"claude:<login>": {"name": "Claude W", "subscription": {"renewsOn": "YYYY-MM-DD",
  "freeResetsLeft": 1, "freeResetsReadOn": "YYYY-MM-DD", "freeResetsExpire": ["YYYY-MM-DDTHH:MM+01:00"]}}},
  and "slots" only for a slot's non-default home. A free reset stops counting when its time has passed.
rotate --dry prints the plan per pane and changes nothing; Discord: /byt <login>.
Codex switch compacts running panes first and preserves model/effort and the exact session when portable.
Busy panes keep a durable request for the existing watcher; dormant panes are selected for their next start, never woken.
--continue-file is single-pane only and queues that continuation once after a verified switch.
Quota warning: answers the human in the channel he writes in, from AMUX_QUOTA_WARN_PERCENT (default 80 %) every 6 h, from AMUX_QUOTA_RESERVE_PERCENT (default 90 %) every 3 h; amux never switches by itself.
Warnings never switch accounts; explicit operator requests use the guarded path above.
Quota floor: at AMUX_QUOTA_FLOOR_PERCENT left on the week (default 3, 0 is off) automatic work waits and parked panes compact;
the owner's own message still goes through, and a reading with room lifts it and resumes parked panes.
Codex credits: a Codex account past a spent 5h or week window would draw paid credits, so automatic work and idle compacts wait
for its reset unless AMUX_CODEX_CREDITS=allow; amux quota shows the balance.
Codex automatic switch: only after a reached weekly limit, spare account quota and exact-session continuity.
Disable with AMUX_CODEX_LIMIT_RECOVERY_ENABLED=false. Predictions never switch accounts.
Claude automatic switch: only after an actual limit banner and a later reading that shows the pane's own week spent,
to the logged-in account with most weekly room below AMUX_QUOTA_RESERVE_PERCENT. Disable with AMUX_CLAUDE_LIMIT_RECOVERY_ENABLED=false.`;

/** WHAT: Builds the quota box Discord shows plus every slot's detail, or the JSON. WHY: Keeps text and JSON views on one collection pass. */
export async function runQuotaCommand(args, {
  readSnapshot = readQuotaSnapshotWithPanes,
  output = console.log,
  boxText = quotaBoxText,
  creditGuard = readCreditStopWeek,
} = {}) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { output(usage); return { help: true }; }
  const allowed = new Set(["--all", "--json"]);
  const invalid = args.find((arg) => !allowed.has(arg));
  if (invalid) throw new Error(`unknown quota option: ${invalid}`);
  const snapshot = await readSnapshot();
  output(args.includes("--json") ? JSON.stringify(snapshot, null, 2) : `${boxText(snapshot)}\n\n${formatQuotaSnapshot(snapshot)}\n${creditStopText(creditGuard())}`);
  return snapshot;
}

/** WHAT: Resolves a login target by slot key, login dir, email or a new login name. WHY: Keeps a second account out of the slots panes start on. */
function loginProfile(catalog, requested, { identityOf, newLogin }) {
  const exact = quotaProfile(catalog, requested);
  if (exact) return exact;
  const [provider, ...rest] = String(requested || "").split(":");
  const name = rest.join(":");
  if (provider !== "claude" || !name) return null;
  return resolveClaudeAccountTarget(name, catalog.filter((profile) => profile.provider === "claude"), { identityOf })
    || newLogin(name);
}

/** WHAT: Dispatches account status and login help. WHY: Keeps provider profiles explicit and token-free. */
export async function cmdAccounts(args, ctxOrOptions = null, suppliedOptions = {}) {
  const hasRuntime = Boolean(ctxOrOptions?.agent && ctxOrOptions?.deliveryQueue);
  const ctx = hasRuntime ? ctxOrOptions : null;
  const options = hasRuntime ? suppliedOptions : (ctxOrOptions || {});
  const {
    catalog = quotaAccountCatalog(),
    identityOf = readClaudeProfileIdentity,
    newLogin = newClaudeLoginProfile,
    readSnapshot = readQuotaSnapshotWithPanes,
    output = console.log,
    prepare = prepareRuntimeProfile,
    rotate = rotateClaudeFleet,
    switchCodex = switchCodexAccounts,
  } = options;
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { output(usage); return { help: true }; }
  if (!args.length || args[0] === "status" || args[0] === "list") {
    return runQuotaCommand([], { readSnapshot, output });
  }
  if (args[0] === "rotate") {
    if (!ctx || args.length < 2 || args.length > 3
        || (args[2] && args[2] !== "--dry")) throw new Error(usage);
    const [provider, id] = String(args[1]).split(":");
    if (provider !== "claude" || !id) throw new Error(usage);
    return rotate(ctx, id, { dry: args[2] === "--dry" });
  }
  if (args[0] === "switch-status") {
    if (!ctx) throw new Error(usage);
    return switchStatusCommand(ctx, args.slice(1), { output });
  }
  if (args[0] === "switch") {
    if (!ctx) throw new Error(usage);
    return options.output ? switchCodex(ctx, args.slice(1), { output }) : switchCodex(ctx, args.slice(1));
  }
  if (args[0] !== "login" || args.length !== 2) throw new Error(usage);
  const selected = loginProfile(catalog, args[1], { identityOf, newLogin });
  if (!selected) throw new Error(`unknown account profile: ${args[1]}\n${usage}`);
  prepare(selected, catalog.filter((profile) => profile.provider === selected.provider));
  const instruction = profileLoginInstruction(selected);
  output(`Logga in ${selected.key} i dess isolerade klientprofil:\n${instruction}\n`
    + "Öppna länken i webbläsaren som är inloggad på kontot, godkänn och klistra in koden. Kontrollera sedan med amux quota.");
  return { profile: selected.key, instruction };
}
