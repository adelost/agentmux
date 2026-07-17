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

import {
  chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync,
  readlinkSync, symlinkSync, unlinkSync, writeFileSync,
} from "fs";
import { dirname, join, resolve } from "path";
import { fileURLToPath } from "url";
import { homedir } from "os";

const HOOK_EVENTS = ["Stop", "Notification", "UserPromptSubmit", "SessionStart"];
const __dir = dirname(fileURLToPath(import.meta.url));
const AGENTMUX_RUNTIME = join(homedir(), ".agentmux");
const INSTALLED_GUARD = join(AGENTMUX_RUNTIME, "hooks", "suggestions-write-guard.mjs");
const INSTALLED_CLIENT = join(AGENTMUX_RUNTIME, "bin", "amux-suggest.mjs");
const INSTALLED_CORE = join(AGENTMUX_RUNTIME, "core", "suggestions-authoring.mjs");
const CLIENT_LINK = join(homedir(), ".local", "bin", "amux-suggest");
// Shell-gated on $TMUX_PANE: non-tmux Claude sessions exit in ~1ms and never
// pay a node startup per turn boundary. Path is quoted (spaces-safe).
const HOOK_CMD = `[ -n "$TMUX_PANE" ] || exit 0; exec node "${join(__dir, "amux-hook.mjs")}"`;
const SUGGESTIONS_GUARD_CMD = `exec node "${INSTALLED_GUARD}"`;
const SETTINGS = join(homedir(), ".claude", "settings.json");

const isAmuxHook = (h) => h?.type === "command" && /amux-hook\.mjs/.test(h?.command || "");
const isSuggestionsGuard = (h) => h?.type === "command"
  && /suggestions-write-guard\.mjs/.test(h?.command || "");

function without(entries, predicate) {
  return (entries || [])
    .map((e) => ({ ...e, hooks: (e.hooks || []).filter((h) => !predicate(h)) }))
    .filter((e) => e.hooks.length > 0);
}

function installSuggestionsAuthoringRuntime() {
  mkdirSync(dirname(INSTALLED_GUARD), { recursive: true });
  mkdirSync(dirname(INSTALLED_CLIENT), { recursive: true });
  mkdirSync(dirname(INSTALLED_CORE), { recursive: true });
  mkdirSync(dirname(CLIENT_LINK), { recursive: true });
  copyFileSync(join(__dir, "suggestions-write-guard.mjs"), INSTALLED_GUARD);
  copyFileSync(join(__dir, "amux-suggest.mjs"), INSTALLED_CLIENT);
  copyFileSync(join(__dir, "..", "core", "suggestions-authoring.mjs"), INSTALLED_CORE);
  chmodSync(INSTALLED_GUARD, 0o755);
  chmodSync(INSTALLED_CLIENT, 0o755);
  chmodSync(INSTALLED_CORE, 0o644);
  if (existsSync(CLIENT_LINK) || lstatSafe(CLIENT_LINK)) {
    if (!lstatSync(CLIENT_LINK).isSymbolicLink()) {
      throw new Error(`refusing to replace non-symlink ${CLIENT_LINK}`);
    }
    const current = resolve(dirname(CLIENT_LINK), readlinkSync(CLIENT_LINK));
    if (current !== INSTALLED_CLIENT) unlinkSync(CLIENT_LINK);
  }
  if (!existsSync(CLIENT_LINK)) symlinkSync(INSTALLED_CLIENT, CLIENT_LINK);
}

function lstatSafe(path) {
  try { return lstatSync(path); } catch { return null; }
}

function removeSuggestionsAuthoringRuntime() {
  const link = lstatSafe(CLIENT_LINK);
  if (link?.isSymbolicLink()
    && resolve(dirname(CLIENT_LINK), readlinkSync(CLIENT_LINK)) === INSTALLED_CLIENT) {
    unlinkSync(CLIENT_LINK);
  }
  for (const path of [INSTALLED_GUARD, INSTALLED_CLIENT, INSTALLED_CORE]) {
    if (existsSync(path)) unlinkSync(path);
  }
}

function main() {
  const dry = process.argv.includes("--dry");
  const remove = process.argv.includes("--remove");

  const settings = existsSync(SETTINGS)
    ? JSON.parse(readFileSync(SETTINGS, "utf-8"))
    : {};
  const hooks = settings.hooks || {};

  for (const event of HOOK_EVENTS) {
    const kept = without(hooks[event], isAmuxHook);
    if (!remove) {
      kept.push({ hooks: [{ type: "command", command: HOOK_CMD, timeout: 10 }] });
    }
    if (kept.length) hooks[event] = kept;
    else delete hooks[event];
  }
  const preToolUse = without(hooks.PreToolUse, isSuggestionsGuard);
  if (!remove) {
    preToolUse.push({ matcher: "Bash", hooks: [{
      type: "command", command: SUGGESTIONS_GUARD_CMD, timeout: 5,
    }] });
  }
  if (preToolUse.length) hooks.PreToolUse = preToolUse;
  else delete hooks.PreToolUse;
  settings.hooks = hooks;
  if (!Object.keys(hooks).length) delete settings.hooks;

  const next = JSON.stringify(settings, null, 2) + "\n";
  if (dry) {
    console.log(next);
    return;
  }
  if (remove) removeSuggestionsAuthoringRuntime();
  else installSuggestionsAuthoringRuntime();
  if (existsSync(SETTINGS)) {
    copyFileSync(SETTINGS, `${SETTINGS}.bak-amux-${Date.now()}`);
  }
  writeFileSync(SETTINGS, next);
  console.log(`${remove ? "removed amux hooks from" : "installed amux hooks in"} ${SETTINGS}`);
  console.log(`events: ${HOOK_EVENTS.join(", ")} -> ${HOOK_CMD}`);
  console.log(`Suggestions mutations: PreToolUse/Bash -> ${SUGGESTIONS_GUARD_CMD}`);
}

main();
