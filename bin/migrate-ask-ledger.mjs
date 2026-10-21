#!/usr/bin/env node
import { migrateDailyLedger } from "../core/ask-ledger-migrate.mjs";
import { defaultAskLedgerPath } from "../core/ask-ledger.mjs";

const args = process.argv.slice(2);
if (args.some(arg => arg.startsWith("--") && arg !== "--apply")) throw Error("Usage: migrate-ask-ledger.mjs [DIRECTORY] [--apply]");
const path = args.find(arg => !arg.startsWith("--")) || defaultAskLedgerPath();
try {
  const result = await migrateDailyLedger(path, { apply: args.includes("--apply"),
    progress: result => console.error(`legacy files ${result.files}, rows ${result.sourceRows}, bytes ${result.sourceBytes}`) });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error.message); process.exitCode = 1;
}
