#!/usr/bin/env node
// CLI: reads raw tmux output from stdin, prints extracted text to stdout.
// Usage: tmux capture-pane ... -p | node bin/extract-text.mjs

import { extractText } from "../core/extract.mjs";

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const raw = Buffer.concat(chunks).toString("utf-8");
const text = extractText(raw);
if (text) process.stdout.write(text + "\n");
