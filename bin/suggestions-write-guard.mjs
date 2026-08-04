#!/usr/bin/env node

import { readFileSync } from "node:fs";

// The Suggestions API host, duplicated here on purpose and ONLY here. This file
// must be able to decide "is this even about Suggestions?" without loading the
// module that owns the real rule, because the fallback below exists precisely
// for the case where that module cannot be loaded.
const SUGGESTIONS_HOST = /https:\/\/(?:suggest|suggestions)\.v1d\.io\/api\//iu;

const block = (reason) => {
  console.error(`BLOCKED: ${reason}`);
  process.exit(2);
};

let payload;
try { payload = JSON.parse(readFileSync(0, "utf8") || "{}"); }
catch (error) {
  console.error(`[suggestions-write-guard] unreadable hook payload: ${error.message}`);
  process.exit(0);
}
if (payload.tool_name !== "Bash") process.exit(0);
const command = String(payload.tool_input?.command ?? "");

// Imported dynamically so a broken or missing dependency lands in this catch
// instead of aborting the process at module load. A top-level import failure
// exits 1, and the hook contract treats anything other than 2 as "allowed" — so
// the guard used to FAIL OPEN. Measured 2026-08-04: the installed copy imported
// core/mangled-swedish.mjs, which the installer never copied, so every pane ran
// with no Suggestions gate at all and nothing said so.
let inspect;
try {
  ({ inspectSuggestionsMutationCommand: inspect } =
    await import("../core/suggestions-authoring.mjs"));
} catch (error) {
  // Degraded mode. Refuse anything that touches the Suggestions API rather than
  // guess at the nuanced rule with a second copy of it that would drift. This is
  // deliberately blunter than the real check and says so, because a guard that
  // cannot evaluate must fail CLOSED on the surface it protects.
  if (SUGGESTIONS_HOST.test(command)) {
    block(`the Suggestions guard could not load its rule (${error.message}), so it is `
      + "refusing every command that touches the Suggestions API. Reinstall the release "
      + "(node bin/install-release.mjs --sha <sha>) and retry.");
  }
  console.error(`[suggestions-write-guard] rule unavailable: ${error.message}`);
  process.exit(0);
}

try {
  const result = inspect(command);
  if (result.blocked) block(result.reason);
} catch (error) {
  if (SUGGESTIONS_HOST.test(command)) {
    block(`the Suggestions guard threw while evaluating this command (${error.message}); `
      + "refusing it rather than passing an unchecked mutation.");
  }
  console.error(`[suggestions-write-guard] skipped: ${error.message}`);
}
process.exit(0);
