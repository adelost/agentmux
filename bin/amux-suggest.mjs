#!/usr/bin/env node

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import {
  defaultSuggestionsTokenFile, displayBodyFile, sendSuggestionsRequest,
} from "../core/suggestions-authoring.mjs";

const usage = () => {
  console.error(`Usage: amux-suggest --method PATCH --path '/api/tickets/AI-0001/admin?project=ai' \\
  --body-file request.json [--expect-file quote.txt ...] \\
  [--read-path '/api/tickets/AI-0001?project=ai'] [--base-url URL] \\
  [--agent-id ai:0] [--token-file PATH] [--state-dir PATH]

--agent-id sends X-Agent-ID, which the /api/agent/* routes require when
authenticating with a fleet key. It is the only header this tool will add.

The request body is sent as the exact strict-UTF-8 bytes read from --body-file.
Each --expect-file must occur unchanged as literal UTF-8 in that body and in the
GET response from --read-path. One final LF or CRLF is treated as text-file
framing, not quote content. Direct inline Suggestions mutations are guarded.`);
};

/** Exported so the flag map can be pinned: a missing flag here is invisible from outside. */
export function parseArgs(argv) {
  const options = { expectFiles: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const name = argv[index];
    if (name === "--help" || name === "-h") return { help: true };
    const value = argv[index + 1];
    if (!name.startsWith("--") || value == null || value.startsWith("--")) {
      throw new Error(`missing value for ${name}`);
    }
    index += 1;
    if (name === "--expect-file") options.expectFiles.push(value);
    // The agent routes authenticate the fleet key against an agent identity, so
    // without this header the sanctioned client cannot reach /api/agent/* at all
    // and an agent is pushed toward hand-rolling its own transport — losing the
    // staging, verbatim check and strict UTF-8 this tool exists to enforce.
    // sendSuggestionsRequest already whitelists exactly this one header; only
    // the flag to reach it was missing.
    else if (name === "--agent-id") options.requestHeaders = { "x-agent-id": value };
    else {
      const key = ({
        "--method": "method", "--path": "path", "--body-file": "bodyFile",
        "--read-path": "readPath", "--base-url": "baseUrl",
        "--token-file": "tokenFile", "--state-dir": "stateDir",
      })[name];
      if (!key) throw new Error(`unknown option ${name}`);
      options[key] = value;
    }
  }
  return options;
}

// Run the CLI only when invoked as the entrypoint. Without this the whole
// try-block executed on plain `import`, so importing the module to test its flag
// map ran a real request path and called process.exit — which is also why the
// map had no test and could lose a flag unnoticed.
const invokedDirectly = process.argv[1]
  && resolve(process.argv[1]) === fileURLToPath(import.meta.url);

if (invokedDirectly) try {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    usage();
    process.exit(0);
  }
  for (const required of ["method", "path", "bodyFile"]) {
    if (!options[required]) throw new Error(`--${required.replace(/[A-Z]/gu, (c) => `-${c.toLowerCase()}`)} is required`);
  }
  const tokenFile = options.tokenFile ?? defaultSuggestionsTokenFile();
  const token = readFileSync(tokenFile, "utf8").trim();
  const result = await sendSuggestionsRequest({ ...options, token });
  process.stdout.write(result.responseText);
  if (!result.responseText.endsWith("\n")) process.stdout.write("\n");
  console.error(`amux-suggest: ${result.status} ${result.mutationId} `
    + `${result.replay ? "replayed" : "sent"} from ${displayBodyFile(options.bodyFile)}`);
} catch (error) {
  console.error(`amux-suggest: ${error.message}`);
  usage();
  process.exit(1);
}
