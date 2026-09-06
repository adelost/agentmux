#!/usr/bin/env node

import { existsSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import {
  decorateClaudeStatusline,
  writeClaudeStatuslineBridge,
} from "../core/claude-statusline.mjs";

const chunks = [];
const modified = (path) => { try { return statSync(path, { bigint: true }).mtimeNs; } catch { return null; } };
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
  let delegatedSince = null;
  if (existsSync(delegate)) {
    const session = String(data?.session_id || "");
    const bridge = session && !/[/\\]|\.\./u.test(session) ? join(tmpdir(), `claude-ctx-${session}.json`) : null;
    const before = bridge ? modified(bridge) : null;
    const started = Math.floor(Date.now() / 1000);
    const result = spawnSync(process.execPath, [delegate], {
      input,
      encoding: "utf8",
      env: process.env,
      timeout: 2_500,
    });
    if (!result.error && result.status === 0) {
      rendered = result.stdout;
      if (bridge && modified(bridge) !== before) delegatedSince = started;
    }
  }
  if (!rendered) {
    const model = data?.model?.display_name || "Claude";
    const percent = Number(data?.context_window?.used_percentage);
    rendered = Number.isFinite(percent) ? `${model} · ${Math.round(percent)}%` : model;
  }

  try { writeClaudeStatuslineBridge(data, { delegatedSince }); } catch { /* status display must remain available */ }
  process.stdout.write(decorateClaudeStatusline(rendered, data?.effort?.level));
});
