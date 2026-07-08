#!/usr/bin/env node
// Install the amux event hooks into ~/.claude/settings.json (idempotent).
//
//   node bin/install-hooks.mjs           # install / upgrade
//   node bin/install-hooks.mjs --dry     # show what would change
//   node bin/install-hooks.mjs --remove  # uninstall amux hooks
//
// One command serves all events (the script reads hook_event_name from
// stdin), registered for Stop / Notification / UserPromptSubmit /
// SessionStart. Existing non-amux hooks are preserved; a timestamped
// backup of settings.json is written before any change.

import { readFileSync, writeFileSync, existsSync, copyFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const HOOK_EVENTS = ["Stop", "Notification", "UserPromptSubmit", "SessionStart"];
const __dir = dirname(fileURLToPath(import.meta.url));
const HOOK_CMD = `node ${join(__dir, "amux-hook.mjs")}`;
const SETTINGS = join(homedir(), ".claude", "settings.json");

const isAmuxHook = (h) => h?.type === "command" && /amux-hook\.mjs/.test(h?.command || "");

function withoutAmux(entries) {
  return (entries || [])
    .map((e) => ({ ...e, hooks: (e.hooks || []).filter((h) => !isAmuxHook(h)) }))
    .filter((e) => e.hooks.length > 0);
}

function main() {
  const dry = process.argv.includes("--dry");
  const remove = process.argv.includes("--remove");

  const settings = existsSync(SETTINGS)
    ? JSON.parse(readFileSync(SETTINGS, "utf-8"))
    : {};
  const hooks = settings.hooks || {};

  for (const event of HOOK_EVENTS) {
    const kept = withoutAmux(hooks[event]);
    if (!remove) {
      kept.push({ hooks: [{ type: "command", command: HOOK_CMD, timeout: 10 }] });
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  settings.hooks = hooks;
  if (!Object.keys(hooks).length) delete settings.hooks;

  const next = JSON.stringify(settings, null, 2) + "\n";
  if (dry) {
    console.log(next);
    return;
  }
  if (existsSync(SETTINGS)) {
    copyFileSync(SETTINGS, `${SETTINGS}.bak-amux-${Date.now()}`);
  }
  writeFileSync(SETTINGS, next);
  console.log(`${remove ? "removed amux hooks from" : "installed amux hooks in"} ${SETTINGS}`);
  console.log(`events: ${HOOK_EVENTS.join(", ")} -> ${HOOK_CMD}`);
}

main();
