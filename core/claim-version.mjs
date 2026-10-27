import { readFileSync } from "node:fs";
import { claimHash } from "./claim-corpus.mjs";

/** WHAT: Calculates the complete measured policy identity. WHY: Prevents changed source validation from reusing old measurement. */
export function claimAlgorithm() {
  return claimHash(["claim-guard.mjs", "claim-sources.mjs", "claim-corpus.mjs"]
    .map(name => readFileSync(new URL(name, import.meta.url), "utf8")).join("\n"));
}
