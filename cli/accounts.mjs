// Small operator CLI for coding-subscription profiles.
//
// It never prints tokens and never changes a running pane implicitly. Login
// commands are provider-scoped; Codex pane switching remains the existing
// explicit /switch flow with continuity checks.

import { formatQuotaSnapshot } from "../core/quota-format.mjs";
import { newClaudeLoginProfile, profileLoginInstruction, quotaAccountCatalog, quotaProfile } from "../core/quota-profiles.mjs";
import { readQuotaSnapshotWithPanes } from "../core/quota-in-use.mjs";
import { prepareRuntimeProfile, resolveClaudeAccountTarget } from "../core/runtime-account-profiles.mjs";
import { readClaudeProfileIdentity } from "../core/claude-account-quota.mjs";
import { rotateClaudeFleet } from "./account-rotation.mjs";

const usage = `Usage:
  amux accounts                                  same view as amux quota
  amux accounts login <codex|kimi>:<1|2>
  amux accounts login claude:<1|2|login|email>   a new login name gets its own dir
  amux accounts rotate claude:<1|2|login|email> [--dry]
  amux quota [--all] [--json]

Login dirs: ~/.config/agent/account-profiles/claude/<login>, one account per dir.
rotate --dry prints the plan per pane and changes nothing; Discord: /byt <login>.
Weekly warning: AMUX_QUOTA_WARN_PERCENT (default 80 % weekly used); amux never switches by itself.`;

/** WHAT: Builds one shared quota view. WHY: Keeps text and JSON views on one collection pass. */
export async function runQuotaCommand(args, {
  readSnapshot = readQuotaSnapshotWithPanes,
  output = console.log,
} = {}) {
  if (args.length === 1 && ["--help", "-h"].includes(args[0])) { output(usage); return { help: true }; }
  const allowed = new Set(["--all", "--json"]);
  const invalid = args.find((arg) => !allowed.has(arg));
  if (invalid) throw new Error(`unknown quota option: ${invalid}`);
  const snapshot = await readSnapshot();
  output(args.includes("--json") ? JSON.stringify(snapshot, null, 2) : formatQuotaSnapshot(snapshot));
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
  if (args[0] !== "login" || args.length !== 2) throw new Error(usage);
  const selected = loginProfile(catalog, args[1], { identityOf, newLogin });
  if (!selected) throw new Error(`unknown account profile: ${args[1]}\n${usage}`);
  prepare(selected, catalog.filter((profile) => profile.provider === selected.provider));
  const instruction = profileLoginInstruction(selected);
  output(`Logga in ${selected.key} i dess isolerade klientprofil:\n${instruction}\n`
    + "Öppna länken i webbläsaren som är inloggad på kontot, godkänn och klistra in koden. Kontrollera sedan med amux quota.");
  return { profile: selected.key, instruction };
}
