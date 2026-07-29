#!/usr/bin/env node

import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  decorateClaudeStatusline,
  writeClaudeStatuslineBridge,
} from "../core/claude-statusline.mjs";

const chunks = [];
process.stdin.on("data", (chunk) => chunks.push(chunk));
process.stdin.on("end", () => {
  const input = Buffer.concat(chunks).toString("utf8");
  let data;
  try {
    data = JSON.parse(input);
  } catch {
    process.exitCode = 0;
    return;
  }

  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
  const delegate = join(configDir, "hooks", "gsd-statusline.js");
  let rendered = "";
  if (existsSync(delegate)) {
    const result = spawnSync(process.execPath, [delegate], {
      input,
      encoding: "utf8",
      env: process.env,
      timeout: 2_500,
    });
    if (!result.error && result.status === 0) rendered = result.stdout;
  }
  if (!rendered) {
    const model = data?.model?.display_name || "Claude";
    const percent = Number(data?.context_window?.used_percentage);
    rendered = Number.isFinite(percent) ? `${model} · ${Math.round(percent)}%` : model;
  }

  try { writeClaudeStatuslineBridge(data); } catch { /* status display must remain available */ }
  process.stdout.write(decorateClaudeStatusline(rendered, data?.effort?.level));
});
