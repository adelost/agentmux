import { execSync } from "node:child_process";
import { readAskLedger } from "../core/ask-ledger.mjs";
import { bindAsks } from "../core/ask-bindings.mjs";
import { detectSenderFromEnv, parseSenderAddress } from "../core/sender-detect.mjs";
import { validateAgentPane } from "./config.mjs";

/** WHAT: Defines ask lookup and binding usage. WHY: Keeps help on the same closure contract as the command. */
export const ASKS_HELP = `Usage: amux asks [agent] [--since 2h] [--open] [--list | --full] [--raw] [--all-sources] [--all-repos] [--summary]\n\nDefault: canonical posted answers, grouped by agent and recent pane.\n--list prints source-bound rows; --full includes complete posted answer text.\n--raw explicitly uses legacy provider diagnostics and line anchors.\n--open keeps unresolved rows, including answered/done human asks without a binding (unbound); a binding shows as bound; needs-you means the operator's hands (a login, a card, a key), a decision for the delegate shows as delegate; --all-sources includes agent/automation input.\n--all-repos includes archived agents; --summary groups by repository.\nBind: amux asks bind ID... --row N | --commit SHA | --close REASON (run from the target repo and a configured pane).\nExample: amux asks claw --open; amux asks claw --pane 5 --full -n 3`;

/** WHAT: Maps exact ask ids to one validated task or explicit closure. WHY: Keeps replies alone from removing a human task from --open. */
export function cmdAskBind(ids, flags, ctx) {
  const targets = ["row", "commit", "close"].filter(key => Object.hasOwn(flags, key));
  if (targets.length !== 1) throw Error("Use exactly one of --row N, --commit SHA or --close REASON");
  const by = detectSenderFromEnv(process.env, command => execSync(command, { encoding: "utf8", timeout: 2000 }));
  const caller = parseSenderAddress(by);
  if (!caller) throw Error("asks bind requires a configured agent:pane caller");
  validateAgentPane(ctx.configPath, caller.session, caller.pane);
  const rows = bindAsks({ ids, kind: targets[0], value: flags[targets[0]], by, cwd: ctx.cwd || process.cwd(),
    ledgerEntries: ctx.readAskLedger ? ctx.readAskLedger() : readAskLedger() });
  for (const row of rows) console.log(`bound ${row.ledgerId} ${row.kind} ${row.ref}`);
  return rows;
}
