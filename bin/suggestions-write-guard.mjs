#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { inspectSuggestionsMutationCommand } from "../core/suggestions-authoring.mjs";

try {
  const payload = JSON.parse(readFileSync(0, "utf8") || "{}");
  if (payload.tool_name !== "Bash") process.exit(0);
  const result = inspectSuggestionsMutationCommand(payload.tool_input?.command);
  if (result.blocked) {
    console.error(`BLOCKED: ${result.reason}`);
    process.exit(2);
  }
} catch (error) {
  console.error(`[suggestions-write-guard] skipped: ${error.message}`);
}
process.exit(0);
