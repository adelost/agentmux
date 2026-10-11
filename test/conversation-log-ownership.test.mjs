import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { component, expect, feature } from "bdd-vitest";

// One module owns the conversation log's format (docs/CONVERSATION-LOG.md).
const ROOT = join(import.meta.dirname, "..");
const OWNER = "core/ask-ledger.mjs";
// The queue picks the ledger path for its own root and hands it to the owner.
const PATH_ONLY = new Set(["core/delivery-queue.mjs"]);
const NAMES_THE_FILE = /["'`][^"'`\n]*ask-ledger(?!\.mjs|-backfill)[^"'`\n]*["'`]|\baskLedgerFiles\b/u;

feature("conversation log ownership", () => {
  component("no module but the owner reads or writes the log file", {
    when: ["scanning every tracked module", () => execFileSync("git", ["ls-files", "*.mjs"], { cwd: ROOT, encoding: "utf8" })
      .split("\n").filter((file) => file && !/\.test\.mjs$|^test\/|^cli\.test\//u.test(file) && file !== OWNER && !PATH_ONLY.has(file))
      .filter((file) => NAMES_THE_FILE.test(readFileSync(join(ROOT, file), "utf8")))],
    then: ["none names the file or its archives", (offenders) => expect(offenders).toEqual([])],
  });
});
