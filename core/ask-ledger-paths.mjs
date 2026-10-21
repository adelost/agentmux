import { readFileSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join } from "node:path";

// WHAT: Checks whether a ledger uses daily files. WHY: Keeps explicit legacy diagnostic paths separate from the canonical directory.
export const isDailyLedger = path => !path.endsWith(".jsonl");

// WHAT: Resolves a row's UTC day file or an explicit legacy file. WHY: Keeps every producer on the same date boundary while preserving explicit diagnostic paths.
export function ledgerWritePath(path, timestamp = new Date().toISOString()) {
  return isDailyLedger(path) ? join(path, new Date(timestamp).toISOString().slice(0, 10) + ".jsonl") : path;
}

// WHAT: Returns retained legacy files. WHY: Keeps rotations and historical recovery archives readable until their daily import is verified.
export function legacyLedgerFiles(path) {
  const current = isDailyLedger(path) ? `${path}.jsonl` : path;
  const dir = dirname(current), name = basename(current), prefix = `${basename(current, ".jsonl")}.`;
  let names;
  try { names = readdirSync(dir); } catch (error) { if (error.code === "ENOENT") return []; throw error; }
  return names.filter(file => file === name || file.startsWith(prefix) && file.endsWith(".jsonl"))
    .sort((a, b) => a === name ? 1 : b === name ? -1 : a.localeCompare(b)).map(file => join(dir, file));
}

// WHAT: Returns daily files and any legacy source not yet imported. WHY: Prevents a rollout or a late legacy writer from hiding unimported conversation content.
export function askLedgerFiles(path) {
  if (!isDailyLedger(path)) return legacyLedgerFiles(path);
  let names = [];
  try { names = readdirSync(path); } catch (error) { if (error.code !== "ENOENT") throw error; }
  let imported = [];
  try { imported = JSON.parse(readFileSync(join(path, "legacy-import.json"), "utf8")).sources || []; }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  const legacy = legacyLedgerFiles(path).filter(file => {
    const prior = imported.find(item => item.path === file);
    if (!prior) return true;
    const stat = statSync(file);
    return stat.size !== prior.bytes || stat.mtimeMs !== prior.mtimeMs;
  });
  return [...legacy, ...names.filter(name => /^\d{4}-\d{2}-\d{2}\.jsonl$/u.test(name)).sort().map(name => join(path, name))];
}

// WHAT: Returns the exact UTC interval named by a daily file. WHY: Keeps date-window reads from probing unrelated days or trusting append order.
export function dailyLedgerSpan(file) {
  const match = /^(\d{4}-\d{2}-\d{2})\.jsonl$/u.exec(basename(file));
  if (!match) return null;
  const firstMs = Date.parse(`${match[1]}T00:00:00Z`);
  return { file, firstMs, lastMs: firstMs + 86_400_000 - 1 };
}
