#!/usr/bin/env node
/** WHAT: Routes ledger publication and mirror updates. WHY: Keeps shared checkouts behind one installed writer and failure contract. */
import { publishLedger, updateLedgerMirror } from "../core/work-ledger-write.mjs";

const args = process.argv.slice(2), options = {};
for (const name of ["repo", "path", "branch"]) {
  const at = args.indexOf(`--${name}`);
  if (at >= 0) { options[name] = args[at + 1]; args.splice(at, 2); }
}
try {
  if (!options.repo) throw new Error("Usage: push_ledger.sh --repo PATH --path docs/TASKS.md [--branch master] SUBJECT GENERATOR [ARGS...]\n       push_ledger.sh --repo PATH --branch master --mirror");
  const mirror = args[0] === "--mirror";
  const result = mirror ? updateLedgerMirror(options.repo, options.branch)
    : publishLedger({ ...options, subject: args.shift(), command: args });
  console.log(JSON.stringify(result));
  if (!result.ok) process.exitCode = 1;
} catch (error) { console.error(error.message); process.exitCode = 1; }
