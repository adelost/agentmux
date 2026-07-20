#!/usr/bin/env node
// Thin CLI over core/windows-recovery.mjs for the Windows rescue tool.
// All decisions live in the core module; this file only parses argv and I/O.

import {
  RECOVERY_STAGES,
  classifyAuthFailure,
  formatRecoveryReport,
  planPostWslRecovery,
} from "../core/windows-recovery.mjs";

const [command, ...rest] = process.argv.slice(2);

function argValue(name) {
  const index = rest.indexOf(name);
  return index >= 0 ? rest[index + 1] : null;
}

function decodeInput() {
  const encoded = argValue("--input-base64");
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/u.test(encoded)) {
    throw new Error("input-base64-missing-or-invalid");
  }
  return JSON.parse(Buffer.from(encoded, "base64").toString("utf8"));
}

if (command === "stages") {
  console.log(JSON.stringify(RECOVERY_STAGES));
} else if (command === "plan") {
  const plan = planPostWslRecovery(decodeInput());
  console.log(JSON.stringify({ ...plan, report: formatRecoveryReport(plan.stages, plan.outcome) }));
} else if (command === "format") {
  const input = decodeInput();
  console.log(formatRecoveryReport(input?.stages || [], input?.outcome || "BLOCKED"));
} else if (command === "classify-auth") {
  console.log(JSON.stringify({ authFailure: classifyAuthFailure(decodeInput()) === "auth-failure" }));
} else {
  console.error("Usage: windows-recovery.mjs stages | plan --input-base64 B | format --input-base64 B | classify-auth --input-base64 B");
  process.exit(2);
}
