// Small operator CLI for coding-subscription profiles.
//
// It never prints tokens and never changes a running pane implicitly. Login
// commands are provider-scoped; Codex pane switching remains the existing
// explicit /switch flow with continuity checks.

import { formatQuotaSnapshot } from "../core/quota-format.mjs";
import { quotaProfile, quotaProfileCatalog, profileLoginInstruction } from "../core/quota-profiles.mjs";
import { readQuotaSnapshot } from "../core/quota-usage.mjs";
import { prepareRuntimeProfile } from "../core/runtime-account-profiles.mjs";
import { rotateClaudeFleet } from "./account-rotation.mjs";

const usage = `Usage:
  amux accounts
  amux accounts login <codex|claude|kimi>:<1|2>
  amux accounts rotate claude:<1|2> [--dry]
  amux quota [--all] [--json]`;

/** WHAT: Builds one shared quota view. WHY: Keeps text and JSON views on one collection pass. */
export async function runQuotaCommand(args, {
  readSnapshot = readQuotaSnapshot,
  output = console.log,
} = {}) {
  const allowed = new Set(["--all", "--json"]);
  const invalid = args.find((arg) => !allowed.has(arg));
  if (invalid) throw new Error(`unknown quota option: ${invalid}`);
  const snapshot = await readSnapshot();
  output(args.includes("--json") ? JSON.stringify(snapshot, null, 2) : formatQuotaSnapshot(snapshot));
  return snapshot;
}

/** WHAT: Dispatches account status and login help. WHY: Keeps provider profiles explicit and token-free. */
export async function cmdAccounts(args, ctxOrOptions = null, suppliedOptions = {}) {
  const hasRuntime = Boolean(ctxOrOptions?.agent && ctxOrOptions?.deliveryQueue);
  const ctx = hasRuntime ? ctxOrOptions : null;
  const options = hasRuntime ? suppliedOptions : (ctxOrOptions || {});
  const {
    catalog = quotaProfileCatalog(),
    readSnapshot = readQuotaSnapshot,
    output = console.log,
    prepare = prepareRuntimeProfile,
    rotate = rotateClaudeFleet,
  } = options;
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
  const selected = quotaProfile(catalog, args[1]);
  if (!selected) throw new Error(`unknown account profile: ${args[1]}\n${usage}`);
  prepare(selected, catalog.filter((profile) => profile.provider === selected.provider));
  const instruction = profileLoginInstruction(selected);
  output(`Logga in ${selected.key} i dess isolerade klientprofil:\n${instruction}`);
  return { profile: selected.key, instruction };
}
