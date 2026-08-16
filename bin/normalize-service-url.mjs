#!/usr/bin/env node

import { normalizeServiceBaseUrl } from "../core/runtime-defaults.mjs";

try {
  process.stdout.write(`${normalizeServiceBaseUrl(process.argv[2], process.argv[3] || "service URL", {
    allowHttpLoopback: true,
  })}\n`);
}
catch (error) {
  console.error(error.message);
  process.exit(1);
}
