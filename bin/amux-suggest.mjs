#!/usr/bin/env node

import { readFileSync } from "node:fs";
import {
  defaultSuggestionsTokenFile, displayBodyFile, sendSuggestionsRequest,
} from "../core/suggestions-authoring.mjs";

const usage = () => {
  console.error(`Usage: amux-suggest --method PATCH --path '/api/tickets/AI-0001/admin?project=ai' \\
  --body-file request.json [--expect-file quote.txt ...] \\
  [--read-path '/api/tickets/AI-0001?project=ai'] [--base-url URL] \\
  [--token-file PATH] [--state-dir PATH]

The request body is sent as the exact strict-UTF-8 bytes read from --body-file.
Each --expect-file must occur unchanged as literal UTF-8 in that body and in the
GET response from --read-path. One final LF or CRLF is treated as text-file
framing, not quote content. Direct inline Suggestions mutations are guarded.`);
};

function parseArgs(argv) {
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

try {
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
