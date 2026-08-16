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
  readlinkSync, realpathSync, symlinkSync, unlinkSync, writeFileSync,
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

// The installed guard runs from ~/.agentmux, NOT from the package tree, so every
// relative import it reaches must be copied alongside it. A hardcoded list of one
// file silently stopped being the whole closure when core/mangled-swedish.mjs was
// added: the installed copy kept an import to a file that was never installed, the
// guard aborted at module load, and because the hook contract reads any exit other
// than 2 as "allowed", the gate failed open across the fleet without a word.
// Derive the closure instead of maintaining it by hand.
export function relativeImportClosure(entryPath, seen = new Set()) {
  const path = resolve(entryPath);
  if (seen.has(path)) return seen;
  seen.add(path);
  const source = readFileSync(path, "utf8");
  for (const match of source.matchAll(/\bfrom\s*["'](\.[^"']*)["']/gu)) {
    relativeImportClosure(resolve(dirname(path), match[1]), seen);
  }
  return seen;
}

function installSuggestionsAuthoringRuntime() {
  mkdirSync(dirname(INSTALLED_GUARD), { recursive: true });
  mkdirSync(dirname(INSTALLED_CLIENT), { recursive: true });
  mkdirSync(dirname(INSTALLED_CORE), { recursive: true });
  mkdirSync(dirname(CLIENT_LINK), { recursive: true });
  copyFileSync(join(__dir, "suggestions-write-guard.mjs"), INSTALLED_GUARD);
  copyFileSync(join(__dir, "amux-suggest.mjs"), INSTALLED_CLIENT);
  // Every core module the guard or the client can reach, not just the entry
  // one. Seeding from suggestions-authoring.mjs repeated the exact hardcoded-
  // closure failure this function's own comment documents: the client grew an
  // import outside that seed (core/board-use-reminder.mjs, 2026-08-04) and the
  // installed CLI died at module load. Derive the closure from the two REAL
  // entrypoints instead, so a new import can never be silently left behind.
  const coreSource = join(__dir, "..", "core");
  const coreDir = dirname(INSTALLED_CORE);
  const entrypoints = [join(__dir, "amux-suggest.mjs"), join(__dir, "suggestions-write-guard.mjs")];
  const closure = new Set();
  for (const entrypoint of entrypoints) relativeImportClosure(entrypoint, closure);
  for (const dependency of closure) {
    if (entrypoints.some((entry) => resolve(entry) === dependency)) continue;
    if (dirname(dependency) !== resolve(coreSource)) {
      throw new Error(`installed guard reaches outside core/: ${dependency}`);
    }
    const installed = join(coreDir, dependency.slice(resolve(coreSource).length + 1));
    copyFileSync(dependency, installed);
    chmodSync(installed, 0o644);
  }
  chmodSync(INSTALLED_GUARD, 0o755);
  chmodSync(INSTALLED_CLIENT, 0o755);
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
  mkdirSync(dirname(SETTINGS), { recursive: true, mode: 0o700 });
  writeFileSync(SETTINGS, next);
  console.log(`${remove ? "removed amux hooks from" : "installed amux hooks in"} ${SETTINGS}`);
  console.log(`events: ${HOOK_EVENTS.join(", ")} -> ${HOOK_CMD}`);
  console.log(`Suggestions mutations: PreToolUse/Bash -> ${SUGGESTIONS_GUARD_CMD}`);
}

// Only run when executed, never on import. This file now exports a helper, and
// importing it to test that helper would otherwise rewrite the caller's real
// ~/.claude/settings.json — which is exactly what happened while writing this
// change. Both sides are realpaths because panes reach these scripts through
// symlinks and path.resolve() does not follow them (see amux-suggest, #283).
const invokedDirectly = process.argv[1]
  && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));

if (invokedDirectly) main();
