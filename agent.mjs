// Agent interaction: send prompts, wait for responses, track progress.
// Manages tmux sessions directly. Single source of truth for claude startup + dismiss.

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join, resolve } from "path";
import { load as loadYaml } from "js-yaml";
import { esc, stripAnsi } from "./lib.mjs";
import { TOOL_GUIDE_HINTS } from "./core/hints-tool-guide.mjs";
import { FLEET_PROCESS_HINTS } from "./core/hints-fleet-process.mjs";
import { createTmuxAdapter } from "./core/tmux.mjs";
import { ensureHeadlessWindow, settleTmuxWindowSize } from "./core/tmux-window-size.mjs";
import { stripPaneChrome } from "./core/pane-chrome.mjs";
import { extractText, extractLastTurn, classifyLines, extractSegments, extractMixedStream, extractTurnByPrompt } from "./core/extract.mjs";
import { detectDialect, COMPOSER_LINE_RE, foreignComposerText } from "./core/dialects.mjs";
import {
  captureClaudePromptEchoCursor,
  captureClaudeSlashReceiptCursor,
  extractFromJsonl,
  isBusyFromJsonl,
  isPromptInJsonl,
  isSlashReceiptInJsonl,
} from "./core/jsonl-reader.mjs";
import {
  captureCodexPromptEchoCursor,
  codexPromptPrefixIdentity,
  extractFromCodexJsonl,
  isBusyFromCodexJsonl,
  isPromptInCodexJsonl,
  latestCodexSessionIdentity,
} from "./core/codex-jsonl-reader.mjs";
import { getContextPercent as getContextPercentByDialect, getContextFromPane } from "./core/context.mjs";
import { findBlockingPrompt } from "./core/dismiss.mjs";
import { claudeProjectDir, classifyHistoryRead } from "./core/claude-paths.mjs";
import { appendEvent } from "./core/events.mjs";
import { resolveTmuxLayout } from "./core/layout.mjs";
import { pastePrompt, promptRequiresAtomicPaste } from "./core/prompt-paste.mjs";
import { startProgressTimer as createProgressTimer } from "./core/progress.mjs";
import {
  clearCodexComposerDraft,
  confirmCodexDraftReleased,
  codexComposerContainsPrompt,
  codexComposerEndsWithPrompt,
  codexComposerHasPasteBlock,
  codexComposerMatchesOwnedDraft,
  codexComposerText,
  codexOffersQueueComposer,
  isCodexFullscreenPager,
  prepareCodexIdle,
  rescueCodexSubmitIfConfirmed,
} from "./core/codex-tui.mjs";
import {
  codexModelOverride,
  codexProfileCatalog,
  prepareCodexProfile,
  selectedCodexProfile,
  setCodexModelOverride,
} from "./core/codex-profiles.mjs";
import { decideCodexStart, liveRolloutWriters } from "./core/codex-session-guard.mjs";
import { waitForCodexUiReady as waitForCodexReady } from "./core/codex-readiness.mjs";
import { mapWithConcurrency } from "./core/concurrency.mjs";
import { createTmuxServerHold } from "./core/tmux-server-hold.mjs";
import { buildClaudeLaunchCommand, buildCodexLaunchCommand } from "./core/agent-launch-command.mjs";
import {
  createTuiStallRecovery,
  isClaudePaneCommand as isClaudeCmd,
  isCodexPaneCommand as isCodexCmd,
  isCodingPaneCommand as isAgentCmd,
  isShellProcess as isShellProc,
} from "./core/tui-stall-recovery.mjs";
import { shouldPastePrompt, submitWithDurableFence } from "./core/delivery-fence.mjs";
import { assertClaudeQuotaAvailable } from "./core/claude-quota-target.mjs";
export { buildClaudeLaunchCommand, buildCodexLaunchCommand } from "./core/agent-launch-command.mjs";
export { shouldPastePrompt, submitWithDurableFence } from "./core/delivery-fence.mjs";
const CODEX_SESSION_STATE_KEY = "codex_session_by_pane_profile_v1";
const CODEX_BOOTSTRAP_ROLLOUT_TIMEOUT_MS = 30_000;
const CODEX_PROMPT_READY_TIMEOUT_MS = 8_000;
function codexDeliveryBlocked(message, { zoomRecoverable = false } = {}) {
  const error = new Error(message);
  error.code = "AMUX_DELIVERY_BLOCKED";
  if (zoomRecoverable) error.zoomRecoverable = true;
  return error;
}

// --- Session isolation ---

/** WHAT: Resolves one pane cwd. WHY: Keeps agent histories isolated across panes. */
export function paneDir(rootDir, pane) {
  const dir = join(rootDir, ".agents", String(pane));
  mkdirSync(dir, { recursive: true });
  ensureGitignored(rootDir, ".agents/");
  ensureAgentHints(rootDir);
  return dir;
}

// Placed in .agents/CLAUDE.md so Claude Code auto-reads it from any pane
// (panes run in .agents/N/, Claude searches upward for CLAUDE.md).
// Survives /compact because CLAUDE.md is system context, not conversation.
//
// The marker lets ensureAgentHints detect stale copies on spawn; bump it
// whenever AGENT_HINTS content changes. Appended content survives upgrades.
// WHAT: Names generated agent policy version. WHY: Keeps stale pane instructions from surviving respawns.
export const HINTS_VERSION = "1.25.0";
/** DTO: Generated agent policy footer marker. */
export const HINTS_END_MARKER = "<!-- amux-hints-end -->";

const AGENT_HINTS = `<!-- amux-hints-version: ${HINTS_VERSION} -->
${TOOL_GUIDE_HINTS}
${FLEET_PROCESS_HINTS}
${HINTS_END_MARKER}
`;

// Write hints as both CLAUDE.md (for Claude Code) and AGENTS.md (for Codex).
// Both tools auto-read their respective file from cwd upward.
//
// Sync strategy:
//   - New files → write AGENT_HINTS as-is
//   - Existing files with matching HINTS_VERSION → leave alone (fresh)
//   - Existing files with older/missing version → replace everything up to
//     HINTS_END_MARKER, preserve any user-appended content below the marker
//
// This way upgrades propagate automatically on next spawn without clobbering
// WHAT: Saves generated agent policy. WHY: Keeps pane instructions synchronized without clobbering operator notes.
export function ensureAgentHints(rootDir) {
  const agentsDir = join(rootDir, ".agents");
  if (!existsSync(rootDir) || !statSync(rootDir).isDirectory()) {
    throw new Error(`agent workspace does not exist: ${rootDir}`);
  }
  mkdirSync(agentsDir, { recursive: true });
  ensureGitignored(rootDir, ".agents/");

  const files = [];
  const tailOf = (content) => {
    const endIdx = content.indexOf(HINTS_END_MARKER);
    if (endIdx < 0) return "";
    const raw = content.slice(endIdx + HINTS_END_MARKER.length);
    // AGENT_HINTS owns exactly one line ending after the marker. Remove only
    // that generated delimiter; every subsequent byte belongs to the operator.
    return raw.startsWith("\n") ? raw.slice(1) : raw;
  };

  // Operator additions below the end marker are workspace RULES, and rules
  // apply to every agent regardless of harness. CLAUDE.md's tail is the
  // canonical copy, mirrored verbatim into AGENTS.md — before this, the
  // worktree ban lived only in CLAUDE.md and codex panes never saw it
  // (2026-07-10). Edit the tail in CLAUDE.md; AGENTS.md edits get replaced.
  let canonicalTail = "";
  try {
    const claudePath = join(agentsDir, "CLAUDE.md");
    if (existsSync(claudePath)) canonicalTail = tailOf(readFileSync(claudePath, "utf-8"));
  } catch { /* fresh dir: no tail yet */ }

  for (const name of ["CLAUDE.md", "AGENTS.md"]) {
    const path = join(agentsDir, name);
    try {
      const current = existsSync(path) ? readFileSync(path, "utf-8") : null;
      const tail = name === "CLAUDE.md" && current !== null ? tailOf(current) : canonicalTail;
      // The marker newline is generated; the remaining tail is operator
      // content and survives byte-for-byte, including intentional whitespace.
      const next = AGENT_HINTS + tail;
      // Content-compare instead of version-compare: also converges tails.
      const changed = current !== next;
      if (changed) writeFileSync(path, next);
      files.push({ name, path, changed, error: null });
    } catch (err) {
      files.push({ name, path, changed: false, error: err.message });
      console.warn(`agent hints write failed (${name}): ${err.message}`);
    }
  }
  return { rootDir, version: HINTS_VERSION, files };
}

function ensureGitignored(rootDir, entry) {
  // Agent pane directories are machine-local runtime state. Prefer Git's
  // local exclude so creating an AMUX session never dirties a shared repo's
  // tracked .gitignore. Non-repo roots keep the historical .gitignore
  // fallback so their generated .agents tree is still hidden when the root
  // later becomes a repository.
  let ignorePath = join(rootDir, ".gitignore");
  try {
    const dotGit = join(rootDir, ".git");
    const stat = statSync(dotGit);
    let gitDir = dotGit;
    if (!stat.isDirectory()) {
      const match = readFileSync(dotGit, "utf-8").match(/^gitdir:\s*(.+)$/m);
      if (!match) throw new Error("unsupported .git pointer");
      gitDir = resolve(rootDir, match[1].trim());
    }
    const infoDir = join(gitDir, "info");
    mkdirSync(infoDir, { recursive: true });
    ignorePath = join(infoDir, "exclude");
  } catch { /* not a Git root: use the .gitignore fallback */ }

  try {
    const content = existsSync(ignorePath) ? readFileSync(ignorePath, "utf-8") : "";
    if (!content.includes(entry)) {
      writeFileSync(ignorePath, content.trimEnd() + "\n" + entry + "\n");
    }
  } catch (err) {
    console.warn(`git exclude update failed: ${err.message}`);
  }
}

// --- Agent factory ---
/** WHAT: Builds the tmux agent lifecycle API. WHY: Keeps bridge routing independent from pane mechanics. */
export function createAgent({ tmuxSocket, configPath, timeout, delay, run, tmuxExec, state = null }) {
  const wait = delay || ((ms) => new Promise((r) => setTimeout(r, ms)));
  // All tmux syntax lives in the adapter (core/tmux.mjs). agent.mjs speaks
  // intent-level primitives; escaping is the adapter's tested concern.
  const t = createTmuxAdapter({ socket: tmuxSocket, exec: tmuxExec });

  // --- Config ---

  function loadConfig() {
    try { return loadYaml(readFileSync(configPath, "utf-8")) || {}; }
    catch { return {}; }
  }

  function agentConfig(name) {
    const config = loadConfig();
    if (!config[name]?.dir) throw new Error(`Agent '${name}' not found in ${configPath}`);
    return config[name];
  }

  // --- tmux primitives ---

  async function hasSession(name) {
    return t.hasSession(name);
  }

  // Strip Claude-session identity vars from tmux's global environment.
  // If the tmux SERVER was started from inside a Claude Code session (e.g.
  // `amux serve` run by an agent's Bash tool), every new pane inherits
  // CLAUDECODE/CLAUDE_CODE_CHILD_SESSION/CLAUDE_CODE_SESSION_ID — and any
  // claude launched there believes it's a child of that session and SILENTLY
  // STOPS PERSISTING its transcript jsonl (2026-06-11 incident: no Discord
  // mirroring, invisible replies across all agents after a reboot recovery).
  async function sanitizeTmuxGlobalEnv() {
    let names = [];
    try {
      names = (await t.globalEnvNames())
        .filter((n) => /^(CLAUDECODE$|CLAUDE_CODE_|CLAUDE_EFFORT$|AI_AGENT$)/.test(n));
    } catch (err) {
      console.warn(`sanitizeTmuxGlobalEnv: show-environment failed: ${err.message}`);
      return;
    }
    // Independent unsets: run them concurrently (tmux serializes server-side).
    await Promise.all(names.map((n) =>
      t.unsetGlobalEnv(n).catch((err) =>
        console.warn(`sanitizeTmuxGlobalEnv: unset ${n} failed: ${err.message}`))));
  }

  async function ensureSession(name) {
    await sanitizeTmuxGlobalEnv();
    if (await hasSession(name)) return;
    await t.newSession(name);
    // The server loaded ~/.tmux.conf when it started. Re-sourcing it for every
    // session reinitializes continuum/resurrect in the middle of this layout.
  }

  async function exitCopyMode(target) {
    try {
      if (await t.paneInMode(target)) {
        // -X cancel (inside the adapter) exits copy/view/choose mode without
        // forwarding any keystroke: race-free vs a raw `q` that could leak
        // into Claude's input box, and independent of mode-keys bindings.
        await t.cancelCopyMode(target);
        await wait(300);
      }
    } catch (err) {
      // Target pane may not exist yet, expected during startup. Log only
      // if this looks unexpected (anything other than "no such pane").
      if (!/no such/.test(err.message || "")) {
        console.warn(`exitCopyMode(${target}) failed: ${err.message}`);
      }
    }
  }

  // --- Pane setup ---

  // Detached windows need room for every split and composer; attached clients
  // retain control of their own terminal geometry.
  const ensureSplitRoom = (name) => ensureHeadlessWindow(t, name);
  const settleWindowSize = async (name, layout) => {
    if (await settleTmuxWindowSize(t, name)) await t.selectLayout(name, layout).catch(() => {});
  };

  async function setupPanes(name, dir) {
    const config = loadConfig();
    const panes = config[name]?.panes || [];
    if (!panes.length) return;

    const layout = resolveTmuxLayout(config[name]?.layout);
    const applyLayout = async () => {
      await t.selectLayout(name, layout).catch((err) =>
        console.warn(`setupPanes: select-layout ${layout} failed: ${err.message}`));
    };

    // Guarantee room + reflow any sliver panes before the first split.
    await ensureSplitRoom(name);
    await applyLayout();
    const existing = await countPanes(name);
    for (let i = existing; i < panes.length; i++) {
      // -c pins the new pane's cwd to its own .agents/N. Without it,
      // tmux inherits cwd from whichever pane is active at split-time —
      // unpredictable after select-layout, and the cause of the
      // pane-N-writes-jsonl-to-agents-M bug that broke Discord channel
      // mapping. paneDir mkdir:s the dir so -c can't fail on it missing.
      const targetDir = paneDir(dir, i);
      const splitTarget = `${name}:.${i - 1}`;
      try {
        await t.splitWindowRight(splitTarget, targetDir);
        await applyLayout();
      } catch (err) {
        console.warn(`setupPanes: split-window ${name} failed: ${err.message}`);
        break;
      }
    }

    await applyLayout();

    const actualPanes = await countPanes(name);
    if (actualPanes < panes.length) {
      console.warn(`setupPanes: ${name} has ${actualPanes}/${panes.length} panes after split; skipping missing panes`);
    }

    for (let i = 0; i < Math.min(panes.length, actualPanes); i++) {
      const target = `${name}:.${i}`;
      if (await isAlreadyRunning(target)) continue;

      if (isAgentCmd(panes[i].cmd)) {
        // Claude/codex panes: skip entirely. startClaude/startCodex (via
        // ensureReady) does cd + start + dismiss when the pane is first
        // used. This avoids burning the agent's first turn on startup
        // before any user prompt arrives.
        continue;
      } else if (panes[i].defer) {
        await t.runShell(target, `cd ${esc(dir)}`);
      } else {
        await t.runShell(target, `cd ${esc(dir)} && ${panes[i].cmd}`);
      }
      await wait(500);
    }
    await t.selectPane(`${name}:.0`).catch((err) =>
      console.warn(`setupPanes: select-pane 0 failed: ${err.message}`));
    await settleWindowSize(name, layout);
  }

  async function countPanes(name) {
    try {
      return await t.paneCount(name);
    } catch (err) {
      // Session may not exist yet, treat as 1 default pane
      return 1;
    }
  }

  async function paneCountAfterReconcile(name, wantedCount) {
    const actual = await countPanes(name);
    if (actual < wantedCount) {
      console.warn(`reconcile: ${name} has ${actual}/${wantedCount} panes after split; skipping missing panes`);
    }
    return actual;
  }

  async function isAlreadyRunning(target) {
    try {
      const cmd = await t.currentCommand(target);
      // Pane is "free" only if a shell is at the prompt. Anything else
      // (claude, rclone, ssh, vim, tail, ...) means a process owns the
      // pane — don't send-keys into it, they'd land as stdin to that process.
      return !/^(bash|zsh|fish|sh|dash)$/.test(cmd);
    } catch {
      // Target doesn't exist → not running
      return false;
    }
  }

  // True when a pane's current process matches the type expected by config.
  // Both claude and codex CLIs are node-based, so the live process name is
  // typically the binary name or "node". Services are matched loosely: any
  // non-shell, non-agent process is assumed to be the configured service.
  function paneTypeMatches(currCmd, wantCmd) {
    if (isClaudeCmd(wantCmd)) return /^(claude|node)$/.test(currCmd);
    if (isCodexCmd(wantCmd)) return /^(codex|node)$/.test(currCmd);
    if (wantCmd === "bash") return isShellProc(currCmd);
    return !isShellProc(currCmd) && !/^(claude|codex|node)$/.test(currCmd);
  }

  async function removeIdleExtraPanes(name, wantedCount, actualCount) {
    const removed = [];
    // Highest first keeps all lower configured indices stable as tmux
    // renumbers after each removal. A foreground process owns its pane even if
    // the pane is outside current config, so only an idle shell is disposable.
    for (let pane = actualCount - 1; pane >= wantedCount; pane--) {
      const target = `${name}:.${pane}`;
      let currentCommand;
      try {
        currentCommand = await t.currentCommand(target);
      } catch (err) {
        console.warn(`reconcile: inspect extra ${target} failed: ${err.message}`);
        continue;
      }
      if (!isShellProc(currentCommand)) continue;
      try {
        await t.killPane(target);
        removed.push({ pane, was: currentCommand });
      } catch (err) {
        console.warn(`reconcile: remove idle extra ${target} failed: ${err.message}`);
      }
    }
    return removed.reverse();
  }

  // --- Reconciliation ---

  /**
   * Align a live tmux session with its config: add missing panes, respawn panes
   * whose current process doesn't match the configured command type. Leaves
   * correctly-matching panes untouched (preserves running claude/service state).
   *
   * Coding panes that get respawned are left as idle shells; ensureReady (or
   * the fleet-wide `amux revive`) starts them without disturbing live peers.
   */
  async function reconcileSession(name) {
    const config = loadConfig();
    const cfg = config[name];
    if (!cfg?.panes?.length) return { skipped: true, reason: "no config" };
    if (!(await hasSession(name))) return { skipped: true, reason: "no session" };

    const summary = { name, added: 0, respawned: [], removedExtras: [], unchanged: 0, extras: 0 };
    const wanted = cfg.panes;
    const layout = resolveTmuxLayout(cfg.layout);
    const applyLayout = async () => {
      await t.selectLayout(name, layout).catch((err) =>
        console.warn(`reconcile: select-layout ${layout} failed: ${err.message}`));
    };

    // Guarantee room + reflow any sliver panes before the first split, else
    // a bad restore (80x24 window / 1-col pane) fails with "no space".
    const needsPanes = (await countPanes(name)) < wanted.length;
    if (needsPanes) {
      await ensureSplitRoom(name);
      await applyLayout();
    }

    const currentCount = await countPanes(name);
    for (let i = currentCount; i < wanted.length; i++) {
      try {
        // See setupPanes for why -c is mandatory. Same bug, same fix.
        const targetDir = paneDir(cfg.dir, i);
        const splitTarget = `${name}:.${i - 1}`;
        await t.splitWindowRight(splitTarget, targetDir);
        summary.added++;
        await applyLayout();
      } catch (err) {
        console.warn(`reconcile: split-window ${name} failed: ${err.message}`);
        break;
      }
    }
    if (summary.added > 0) {
      await applyLayout();
    }
    let actualCount = await paneCountAfterReconcile(name, wanted.length);
    if (actualCount > wanted.length) {
      summary.removedExtras = await removeIdleExtraPanes(name, wanted.length, actualCount);
      if (summary.removedExtras.length) {
        await applyLayout();
        actualCount = await paneCountAfterReconcile(name, wanted.length);
      }
    }
    if (actualCount > wanted.length) summary.extras = actualCount - wanted.length;
    if (actualCount < wanted.length) summary.missing = wanted.length - actualCount;

    for (let i = 0; i < Math.min(wanted.length, actualCount); i++) {
      const target = `${name}:.${i}`;
      const want = wanted[i];
      let currCmd = "";
      try {
        currCmd = await t.currentCommand(target);
      } catch { continue; }

      if (paneTypeMatches(currCmd, want.cmd)) { summary.unchanged++; continue; }

      // Safety: never respawn a pane that's running claude or codex, even
      // if config says something else. User may have active work there;
      // forcing a slot into a shell would destroy context. Report as a
      // mismatch instead.
      if (/^(claude|codex|node)$/.test(currCmd)) {
        summary.mismatches = summary.mismatches || [];
        summary.mismatches.push({ pane: i, has: currCmd, expected: want.name });
        continue;
      }

      // Only respawn panes where the current process is a shell (idle) or a
      // clearly non-interactive process (tail, rclone, etc). This is what
      // fixes the original bug: pane has `tail` but config wants claude.
      // -c uses paneDir(cfg.dir, i) so the respawned shell lands in the
      // pane's own .agents/N — same fix-rationale as the split-window
      // calls above; sourcing cwd from cfg.dir alone caused panes 4..N
      // to share the agent root and write claude jsonl to the wrong
      // project hash.
      const respawnDir = paneDir(cfg.dir, i);
      try {
        if (isAgentCmd(want.cmd) || want.cmd === "bash") {
          // Leave as shell; startClaude/startCodex runs on demand when
          // pane is used.
          await t.respawnPane(target, { kill: true, cwd: respawnDir });
        } else {
          // Services must mirror setupPanes: shell pane + send-keys
          // 'cd <root> && cmd'. Services run from the repo root (that's
          // where Makefile/package.json live), not .agents/N. And the
          // command must run INSIDE a shell — with respawn-pane '<cmd>'
          // the command IS the pane process, so a service that exits
          // immediately closes the pane, renumbers the rest, and makes
          // every later respawn target miss ("can't find pane: N").
          await t.respawnPane(target, { kill: true, cwd: cfg.dir });
          await t.runShell(target, `cd ${esc(cfg.dir)} && ${want.cmd}`);
        }
        summary.respawned.push({ pane: i, was: currCmd, expected: want.name });
      } catch (err) {
        console.warn(`reconcile: respawn ${target} failed: ${err.message}`);
      }
    }

    await applyLayout();
    await settleWindowSize(name, layout);
    return summary;
  }

  // --- Claude lifecycle ---

  async function startClaude(name, target, rootDir, pane = 0) {
    return tuiRecovery.startClaude(name, target, rootDir, pane);
  }

  async function startCodex(name, target, rootDir, pane = 0, launch = null) {
    if (await isPaneDead(target)) await respawnPane(target);
    if (await isAlreadyRunning(target)) return;

    const dir = paneDir(rootDir, pane);
    const catalog = codexProfileCatalog();
    const profile = launch?.profile || selectedCodexProfile(state, name, pane, catalog);
    prepareCodexProfile(profile, catalog[0]);

    const owner = `${name}:${pane}@${profile.id}`;
    const allSessionState = state?.get?.(CODEX_SESSION_STATE_KEY, {}) || {};
    const remembered = allSessionState[owner] || null;
    const discovered = latestCodexSessionIdentity(dir, {
      sessionDirs: [join(profile.home, "sessions")],
    });
    const requestedSessionId = launch?.resumeSessionId
      || agentConfig(name).panes?.[pane]?.resumeSessionId
      || null;
    const persisted = requestedSessionId
      ? { pane: owner, sessionId: requestedSessionId }
      : discovered
        ? { pane: owner, sessionId: discovered.sessionId }
        : remembered?.sessionId
          ? { pane: owner, sessionId: remembered.sessionId }
          : null;
    const decision = decideCodexStart({
      pane: owner,
      persisted,
      rolloutPathFor: (sessionId) => discovered?.sessionId === sessionId ? discovered.path : null,
      writersFor: liveRolloutWriters,
      allowFreshBootstrap: !remembered && !discovered && !requestedSessionId,
    });
    if (decision.action === "blocked") {
      const holders = decision.heldBy?.length ? ` (live writer ${decision.heldBy.join(",")})` : "";
      throw new Error(`Codex continuity blocked for ${owner}: ${decision.reason}${holders}`);
    }

    const persistSession = (record) => {
      if (!state?.set) return;
      state.set(CODEX_SESSION_STATE_KEY, {
        ...(state.get(CODEX_SESSION_STATE_KEY, {}) || {}),
        [owner]: { pane: owner, profileId: profile.id, ...record },
      });
    };
    if (decision.action === "fresh") {
      // Fence before process creation: a failed bootstrap must not silently
      // create another unrelated session on the next delivery.
      persistSession({ sessionId: null, status: "bootstrapping", startedAt: Date.now() });
    } else {
      persistSession({ sessionId: decision.sessionId, status: "ready", rolloutPath: discovered.path });
    }

    let override = launch?.model
      ? { model: launch.model, effort: launch.effort ?? null }
      : codexModelOverride(state, name, pane);
    // First launch after upgrading agentmux has no pane-local state yet.  Pin
    // the last effective turn before starting so a global config value (the
    // historical /model bug) cannot silently overwrite every pane on reboot.
    if (!override && state) {
      const previous = getContextPercentByDialect(dir, "codex");
      if (previous?.model) {
        override = { model: previous.model, effort: previous.effort ?? null };
        try { setCodexModelOverride(state, name, pane, override.model, override.effort); }
        catch (err) { console.warn(`startCodex: could not pin ${name}:${pane} model: ${err.message}`); }
      }
    }
    // Resume only the exact pane/profile-owned session selected above. A bare
    // launch is permitted solely for the fenced first bootstrap.
    const cmd = buildCodexLaunchCommand({
      profileHome: profile.home,
      model: override?.model || null,
      effort: override?.effort || null,
      resumeSessionId: decision.action === "resume" ? decision.sessionId : null,
      allowFreshBootstrap: decision.action === "fresh",
    });
    await t.runShell(target, `cd ${esc(dir)} && ${cmd}`);
    await wait(2000);

    if (decision.action === "fresh") {
      let created = null;
      const deadline = Date.now() + CODEX_BOOTSTRAP_ROLLOUT_TIMEOUT_MS;
      while (!created && Date.now() < deadline) {
        created = latestCodexSessionIdentity(dir, { sessionDirs: [join(profile.home, "sessions")] });
        if (!created) await wait(200);
      }
      if (!created) throw new Error(`Codex bootstrap for ${owner} produced no pane-owned rollout`);
      persistSession({ sessionId: created.sessionId, status: "ready", rolloutPath: created.path });
    }
  }

  /**
   * Restart one idle Codex pane under an explicit account/model selection.
   * The caller performs the draft gate and native /status verification; this
   * method owns only the process boundary and never touches another pane.
   */
  async function restartCodex(agentName, pane, launch) {
    const config = agentConfig(agentName);
    const paneCmd = config.panes?.[pane]?.cmd || "";
    if (!isCodexCmd(paneCmd)) throw new Error(`${agentName}:${pane} is not a Codex pane`);
    if (await isBusy(agentName, pane)) throw new Error(`${agentName}:${pane} is still working`);

    const target = `${agentName}:.${pane}`;
    const dir = paneDir(config.dir, pane);
    await t.respawnPane(target, { kill: true, cwd: dir });

    // Wait for the replacement shell before sending the launch command.
    const shellDeadline = Date.now() + 5000;
    while (Date.now() < shellDeadline) {
      const command = await t.currentCommand(target).catch(() => "");
      if (isShellProc(command)) break;
      await wait(100);
    }
    await startCodex(agentName, target, config.dir, pane, launch);

    const processDeadline = Date.now() + 12_000;
    while (Date.now() < processDeadline) {
      const command = await t.currentCommand(target).catch(() => "");
      if (/^(codex|node)$/.test(command)) {
        if (!(await waitForCodexUiReady(target, agentName, pane))) {
          throw new Error(`Codex process started but its composer never became ready in ${agentName}:${pane}`);
        }
        return { ok: true, profile: launch.profile.id, model: launch.model || null, effort: launch.effort || null };
      }
      await wait(200);
    }
    throw new Error(`Codex did not start in ${agentName}:${pane}`);
  }

  async function restartPaneExact(agentName, pane) {
    return tuiRecovery.restartPaneExact(agentName, pane);
  }

  async function isPaneDead(target) {
    try {
      return await t.paneDead(target);
    } catch {
      // Target doesn't exist → not dead (doesn't exist yet)
      return false;
    }
  }

  async function respawnPane(target) {
    // Record the old pid so we can confirm the new shell forked. Without
    // this, the 500ms hard-wait was either wasteful (shell ready in 50ms)
    // or insufficient (tmux hadn't finished respawning yet), and the
    // subsequent `cd && claude` send-keys could go to a pty that hadn't
    // been wired to a readline loop yet.
    let oldPid = "";
    try {
      oldPid = await t.panePid(target);
    } catch {
      // pane may not exist yet or be fully dead, treat as unknown pid
    }

    try {
      await t.respawnPane(target, { kill: true });
    } catch (err) {
      console.warn(`respawnPane(${target}) failed: ${err.message}`);
      return;
    }

    // Poll for a new shell pid to appear. Tmux send-keys buffers to the
    // pty even before readline is active, so as long as the fork happened
    // we're safe to start sending commands. .bashrc will consume them
    // once it finishes initializing.
    const deadline = Date.now() + 5000;
    while (Date.now() < deadline) {
      try {
        const [newPid, cmd] = await Promise.all([
          t.panePid(target),
          t.currentCommand(target),
        ]);
        if (newPid && newPid !== oldPid && /^(bash|zsh|sh|fish|dash)$/.test(cmd)) return;
      } catch {
        // keep polling
      }
      await wait(100);
    }
    console.warn(`respawnPane(${target}) timed out waiting for new shell`);
  }

  /**
   * --continue exactly when this pane dir has session history. ENOENT means
   * a legitimately new pane (silent). Any OTHER readdir failure gets one
   * retry, then spawns bare — but loudly: a swallowed fs flake here used to
   * downgrade a resume to a fresh session with zero trace, i.e. the pane
   * lost its context and nothing recorded why (api:2 review, 1.20.54). The
   * context_loss ledger row is what makes the resume-hint's residual class
   * measurable; the SessionStart hint itself is the recovery pointer.
   */
  async function resolveSessionFlag(dir, agentName, pane) {
    const projectDir = claudeProjectDir(dir);
    let read = classifyHistoryRead(projectDir);
    if (read.error) {
      await wait(300);
      read = classifyHistoryRead(projectDir);
    }
    if (read.error) {
      const detail = `readdir ${read.error.code || read.error.message} on ${projectDir}; spawning WITHOUT --continue, pane loses its session`;
      console.error(`resolveSessionFlag: ${detail}`);
      try {
        appendEvent({
          ts: new Date().toISOString(),
          event: "context_loss",
          session: agentName,
          pane: Number(pane) || 0,
          detail,
        });
      } catch (err) {
        console.error(`resolveSessionFlag: ledger row failed too: ${err.message}`);
      }
    }
    return read.history ? "--continue" : "";
  }

  /** Wait for claude to load, dismiss any blocking prompts if they appear. */
  async function waitForClaudeReady(target, agentName, pane, timeoutMs = 30_000) {
    return tuiRecovery.waitForClaudeReady(target, agentName, pane, timeoutMs);
  }

  /**
   * Codex resume can replay a large transcript for several seconds while its
   * process is already `node` and the old jsonl correctly says idle.  Process
   * state alone is therefore not readiness. Poll for a real composer; when a
   * completed turn omits it, one spaced Escape asks Codex to reveal its exact
   * neutral-state receipt. Never double-Escape after the receipt appears (the
   * second would edit the previous message).
   */
  const waitForCodexUiReady = (target, agentName, pane, hardTimeoutMs) =>
    waitForCodexReady({ tmux: t, target, agentName, pane, delay: wait, hardTimeoutMs });

  // --- Dismiss ---

  async function dismissBlockingPrompt(target) {
    let paneText;
    try {
      paneText = await t.capture(target, { lines: 20 });
    } catch (err) {
      console.warn(`dismiss: capture failed for ${target}: ${err.message}`);
      return null;
    }

    const prompt = findBlockingPrompt(paneText);
    if (!prompt) return null;

    await t.sendKeys(target, prompt.keys);
    await wait(prompt.waitMs);
    return prompt.name;
  }

  // --- Query ---

  async function getResponse(agentName, pane) {
    const raw = await capturePane(agentName, pane, 5000);
    return extractText(raw) || "(empty response)";
  }

  /** Derive which agent dialect a pane runs from its configured cmd. */
  function paneDialectName(agentName, pane) {
    try {
      const config = agentConfig(agentName);
      const cmd = config.panes?.[pane]?.cmd || "";
      if (cmd.includes("codex")) return "codex";
      if (cmd.includes("claude")) return "claude";
      return null;
    } catch (err) {
      console.warn(`paneDialectName(${agentName}) failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Derive dialect from the live pane when config is stale.
   *
   * Some long-running panes can be repurposed without agents.yaml changing
   * first. Example: ai:p3 is configured as a service pane, but currently runs
   * Codex (node). Config-only dialect detection then misses Codex-specific
   * echo checks and send quirks. Keep this as a fallback so configured Claude
   * panes remain fast and deterministic.
   */
  async function livePaneDialectName(agentName, pane) {
    const configured = paneDialectName(agentName, pane);
    if (configured) return configured;

    const target = `${agentName}:.${pane}`;
    try {
      if ((await t.currentCommand(target)) !== "node") return null;

      const raw = await capturePane(agentName, pane, 120);
      const dialect = detectDialect(raw);
      return dialect?.name || null;
    } catch (err) {
      console.warn(`livePaneDialectName(${agentName}:${pane}) failed: ${err.message}`);
      return null;
    }
  }

  async function isBusy(agentName, pane, promptText = null) {
    // Source of truth: read the agent's own session file instead of parsing
    // tmux rendering. Dispatch on the pane's configured cmd so we don't
    // cross-read another agent's jsonl (cdx and claw can share pane dirs).
    try {
      const config = agentConfig(agentName);
      const dir = paneDir(config.dir, pane);
      const dialect = paneDialectName(agentName, pane);

      if (dialect === "codex") {
        const r = isBusyFromCodexJsonl(dir);
        if (r !== null) return r;
      } else if (dialect === "claude") {
        const r = isBusyFromJsonl(dir, promptText);
        if (r !== null) return r;
        // jsonl exists but our prompt isn't there yet. Claude hasn't
        // written it. Assume busy so we keep polling. workMaxMs is the
        // safety escape if this never resolves.
        return true;
      }
    } catch (err) {
      console.warn(`isBusy(${agentName}) dispatch failed, falling back to tmux: ${err.message}`);
    }

    // Fallback: tmux parsing (Codex, missing jsonl, no matching prompt yet)
    const raw = await capturePane(agentName, pane, 20);
    const dialect = detectDialect(raw);

    // Dialect-specific busy signals. Each entry can be a string (substring
    // match) or a RegExp (pattern match). Supports both literal indicators
    // like "esc to interrup" and shape-matchers like /\w+ing…\s*\(/ for
    // thinking verbs (Musing…, Orchestrating…, Doing…).
    const hit = dialect.busySignals?.some((sig) =>
      typeof sig === "string" ? raw.includes(sig) : sig.test(raw),
    );
    if (hit) return true;

    // Dialects that always show a placeholder in their prompt (e.g. Codex)
    // can't use prompt-has-text as a busy signal. Rely on busySignals only.
    if (!dialect.idleWhenPromptEmpty) return false;

    // Dialects with an empty prompt when idle (e.g. Claude Code)
    const lines = raw.split("\n").map((l) => l.trim()).filter(Boolean);
    const tail = lines.slice(-10);
    const promptLine = tail.findLast((l) => l.startsWith(dialect.promptChar));
    if (!promptLine) return true;
    return promptLine.slice(dialect.promptChar.length).trim().length > 0;
  }

  async function getResponseSegments(agentName, pane) {
    const raw = await capturePane(agentName, pane, 5000);
    return extractSegments(classifyLines(extractLastTurn(raw)));
  }

  /** Get text + tool calls in order. If promptText given, finds that exact turn. */
  async function getResponseStream(agentName, pane, promptText = null) {
    const { items } = await getResponseStreamWithRaw(agentName, pane, promptText);
    return items;
  }

  /**
   * Same as getResponseStream but also returns raw buffer + turn slice (for recording).
   *
   * Source-of-truth strategy:
   *   1. Prefer Claude's jsonl session file. It has exact text with code fences,
   *      structured tool_use blocks, and no UI rendering artifacts. This eliminates
   *      narrow-pane wordwrap, progress-icon interference, code-block destruction, etc.
   *   2. Fall back to tmux extract if jsonl is missing (Codex or fresh session)
   *      or contains no matching turn (e.g. echo confirmed but claude crashed
   *      before writing the response).
   */
  async function getResponseStreamWithRaw(agentName, pane, promptText = null) {
    const config = agentConfig(agentName);
    const dir = paneDir(config.dir, pane);
    const dialect = paneDialectName(agentName, pane);

    // Dispatch to the pane's actual dialect, not trial-and-error. Otherwise
    // cdx and claw (which can share pane dirs like .agents/0/) would read
    // each other's jsonl files.
    if (dialect === "codex") {
      const codex = extractFromCodexJsonl(dir, promptText);
      if (codex && codex.items.length > 0) return codex;
    } else if (dialect === "claude") {
      const claude = extractFromJsonl(dir, promptText);
      if (claude && claude.items.length > 0) return claude;
    }

    // Last-resort fallback: tmux parsing.
    const raw = await capturePane(agentName, pane, 5000);
    const turn = promptText ? extractTurnByPrompt(raw, promptText) : extractLastTurn(raw);
    const items = extractMixedStream(classifyLines(turn));

    // Quality gate: when the last turn is mostly pane-chrome (input box,
    // spinner glyphs, progress bars, model+context footer) the extractor
    // happily returns it as "text". Discord ends up showing block characters
    // and Claude UI elements as if they were the agent's reply. Strip those
    // first; if nothing meaningful survives, return empty rather than ship
    // junk. Better silence than gibberish.
    const cleaned = items.map((it) =>
      it.type === "text" ? { ...it, content: stripPaneChromeForFallback(it.content) } : it,
    ).filter((it) => it.type !== "text" || it.content.trim().length > 0);

    if (items.length > 0 && cleaned.length === 0) {
      console.warn(`[${agentName}:${pane}] tmux fallback rejected — all items were pane-chrome`);
      return { raw, turn, items: [], source: "tmux-rejected" };
    }
    return { raw, turn, items: cleaned, source: "tmux" };
  }

  // Pane-chrome stripping is shared (core/pane-chrome.mjs) so a chrome
  // pattern learned once (e.g. the fable footer) protects the tmux
  // fallback, the voice route and any future consumer at the same time.
  const stripPaneChromeForFallback = stripPaneChrome;

  /**
   * True when the source-of-truth session store already contains response
   * items for this exact prompt. No tmux fallback here, we only want a
   * positive signal from structured data.
   */
  function hasResponseForPrompt(agentName, pane, promptText) {
    const needle = promptText?.trim();
    if (!needle) return false;

    const config = agentConfig(agentName);
    const dir = paneDir(config.dir, pane);
    const dialect = paneDialectName(agentName, pane);

    if (dialect === "codex") {
      const codex = extractFromCodexJsonl(dir, promptText);
      return Boolean(codex?.items?.length);
    }
    if (dialect === "claude") {
      const claude = extractFromJsonl(dir, promptText);
      return Boolean(claude?.items?.length);
    }
    return false;
  }

  async function capturePane(agentName, pane, lines = 50) {
    // join=true (-J) merges wrapped lines into single logical lines. Without
    // it, narrow panes (e.g. 42-col panes in main-vertical layouts) split the
    // prompt and response across multiple lines, confusing extract which
    // treats continuation lines as new text segments.
    const stdout = await t.capture(`${agentName}:.${pane}`, { lines });
    return stripAnsi(stdout).trimEnd() || "(empty)";
  }

  async function captureScreen(agentName, pane) {
    const stdout = await t.captureScreen(`${agentName}:.${pane}`);
    return stripAnsi(stdout).trimEnd() || "(empty)";
  }

  /**
   * Poll the pane until the user's prompt text appears in session jsonl,
   * confirming the agent has actually received the input.
   *
   * Source of truth: the agent's own session jsonl. When the user prompt
   * appears there, we know for certain the agent received it. No tmux
   * pane width tricks, no wordwrap to fight, and no generic busy signal
   * pretending that unrelated keystrokes were accepted.
   *
   * @returns true if echo seen, false on timeout
   */
  async function waitForPromptEcho(agentName, pane, promptText, timeoutMs = 15000, {
    notBeforeMs = 0,
    cursor = null,
  } = {}) {
    const needle = promptText?.trim();
    if (!needle) return true;

    const dir = paneDir(agentConfig(agentName).dir, pane);
    const dialect = paneDialectName(agentName, pane);

    const deadline = Date.now() + Math.max(0, timeoutMs);
    // Always inspect once. A zero-timeout check is used by durable Discord
    // replay to prove that an earlier attempt eventually reached JSONL before
    // it considers typing the same message again.
    while (true) {
      // Try jsonl first (width-independent, reliable)
      let found = null;
      if (dialect === "claude") found = isPromptInJsonl(dir, promptText, { notBeforeMs, cursor });
      else if (dialect === "codex") {
        found = isPromptInCodexJsonl(dir, promptText, { notBeforeMs, cursor });
      }
      if (found === true) return true;

      if (Date.now() >= deadline) break;
      await wait(200);
    }
    return false;
  }

  /**
   * Snapshot exact prompt-event identities before a pane write. The returned
   * serializable cursor can survive a bridge retry/restart and proves that a
   * later identical JSONL event is new without using cross-machine clocks.
   */
  async function capturePromptEchoCursor(agentName, pane, promptText) {
    const dir = paneDir(agentConfig(agentName).dir, pane);
    const dialect = paneDialectName(agentName, pane);
    if (dialect === "claude") return captureClaudePromptEchoCursor(dir, promptText);
    if (dialect === "codex") return captureCodexPromptEchoCursor(dir, promptText);
    return null;
  }

  async function captureSlashReceiptCursor(agentName, pane, commandText) {
    const dir = paneDir(agentConfig(agentName).dir, pane);
    return paneDialectName(agentName, pane) === "claude"
      ? captureClaudeSlashReceiptCursor(dir, commandText)
      : null;
  }

  async function waitForSlashReceipt(agentName, pane, commandText, timeoutMs = 15_000, {
    notBeforeMs = 0,
    cursor = null,
  } = {}) {
    if (paneDialectName(agentName, pane) !== "claude") return false;
    const dir = paneDir(agentConfig(agentName).dir, pane);
    const deadline = Date.now() + Math.max(0, timeoutMs);
    while (true) {
      if (isSlashReceiptInJsonl(dir, commandText, { notBeforeMs, cursor }) === true) return true;
      if (Date.now() >= deadline) return false;
      await wait(200);
    }
  }

  // --- Send ---

  /**
   * Codex accepts typed input only when its real composer is visible. During
   * /status, transcript replay, or startup paint, tmux keystrokes can land in
   * a toast/overlay instead (claw:10 retained only the first "i" of an
   * Instagram prompt on 2026-07-12). A visible, empty composer is safe even
   * during a running turn: Codex treats the new user prompt as steering and
   * writes its exact receipt to JSONL. Unknown overlays still fail closed.
   */
  async function waitForCodexPromptReady(agentName, pane) {
    // Prompt input is transport setup, not agent work. Reusing the generic
    // ten-minute work timeout here made one stuck composer hold the Discord
    // channel queue for minutes. Busy Codex panes may accept a steering turn;
    // the exact JSONL echo remains the delivery proof.
    const deadline = Date.now() + CODEX_PROMPT_READY_TIMEOUT_MS;
    let lastError = "composer is not ready";
    const driver = { isBusy, capturePane, captureScreen, sendEscape, sendTab, typeLiteral };

    while (Date.now() < deadline) {
      const ready = await prepareCodexIdle({
        agent: driver,
        name: agentName,
        pane,
        sleep: wait,
        allowBusy: true,
        requireVisibleComposer: true,
        openBusyQueue: true,
      });
      if (ready.ok) return ready;
      lastError = ready.error || lastError;
      // Never overwrite a real draft. Retrying delivery would only type on
      // top of it, so fail immediately and let the caller warn the human.
      // zoomRecoverable: narrow-pane Ratatui wraps can make placeholder
      // chrome read as a draft (2026-07-14 blackhole); the one zoomed retry
      // re-reads at canonical width, where a REAL draft still blocks.
      if (/composer is not empty/i.test(lastError)) {
        throw codexDeliveryBlocked(`Codex prompt delivery blocked: ${lastError}`, {
          zoomRecoverable: true,
        });
      }
      await wait(250);
    }
    throw codexDeliveryBlocked(`Codex prompt delivery timed out: ${lastError}`, {
      zoomRecoverable: true,
    });
  }

  async function recoverKnownCodexDraft(agentName, pane, prompt) {
    const deadline = Date.now() + CODEX_PROMPT_READY_TIMEOUT_MS;
    const target = `${agentName}:.${pane}`;
    while (Date.now() < deadline) {
      let snapshot = await captureScreen(agentName, pane).catch(() => "");
      if (isCodexFullscreenPager(snapshot)) {
        await t.sendLiteral(target, "q").catch(() => {});
        await wait(250);
        continue;
      }
      let composer = codexComposerText(snapshot);
      if (composer !== null) {
        if (codexComposerContainsPrompt(snapshot, prompt)
            || (promptRequiresAtomicPaste(prompt) && codexComposerMatchesOwnedDraft(snapshot, prompt))) {
          return { hasDraft: true, busy: Boolean(await isBusy(agentName, pane).catch(() => false)) };
        }
        if (composer === "") {
          throw codexDeliveryBlocked(
            "Codex prompt delivery blocked: durable draft is not visible; refusing to paste it again",
          );
        }
        throw codexDeliveryBlocked(
          `Codex prompt delivery blocked: composer contains a different draft (starts with: ${composer.slice(0, 60)})`,
          { zoomRecoverable: true },
        );
      }

      const busy = Boolean(await isBusy(agentName, pane).catch(() => true));
      if (busy && codexOffersQueueComposer(snapshot)) {
        await t.sendKeys(target, "Tab");
        await wait(250);
        continue;
      }
      if (!busy) {
        // An idle compositor may be between paints after the prior failed
        // attempt. The ordinary readiness gate safely reveals it.
        const ready = await waitForCodexPromptReady(agentName, pane);
        snapshot = ready?.snapshot || "";
        composer = codexComposerText(snapshot);
        if (composer === "") {
          throw codexDeliveryBlocked(
            "Codex prompt delivery blocked: durable draft is not visible; refusing to paste it again",
          );
        }
      }
      await wait(250);
    }
    throw codexDeliveryBlocked("Codex prompt delivery blocked: owned draft is not currently recoverable", {
      zoomRecoverable: true,
    });
  }

  async function sendPrompt(agentName, prompt, pane, {
    knownDrafted = false,
    onPasteStarted = null,
    onDrafted = null,
    onSubmitting = null,
    onSubmitted = null,
  } = {}) {
    assertClaudeQuotaAvailable(agentName, pane, { prompt, configPath });
    const target = `${agentName}:.${pane}`;
    const notBeforeMs = Date.now();
    await exitCopyMode(target);
    const dialect = await livePaneDialectName(agentName, pane);
    let alreadyComposed = await promptAlreadyInComposer(agentName, pane, prompt, {
      ownedDraft: knownDrafted,
    });
    let busyAtSend = false;
    let exactDraft = dialect === "codex" && alreadyComposed;

    if (dialect === "codex" && knownDrafted && !alreadyComposed) {
      const recovered = await recoverKnownCodexDraft(agentName, pane, prompt);
      alreadyComposed = recovered.hasDraft;
      exactDraft = recovered.hasDraft;
      busyAtSend = recovered.busy;
    }

    if (!shouldPastePrompt({ knownDrafted, alreadyComposed }) && !alreadyComposed) {
      throw codexDeliveryBlocked(
        "Prompt delivery blocked: durable draft is not visible; refusing to paste it again",
      );
    }

    // Idempotent retries: if a previous attempt left this exact prompt
    // sitting unsubmitted in the composer, typing it again would double the
    // text. Skip straight to the submit path instead.
    if (shouldPastePrompt({ knownDrafted, alreadyComposed })) {
      // Recovery must run before the empty-composer readiness gate. v1.21.2
      // accidentally reversed these calls, so the gate rejected the stale
      // text that this function was specifically built to clear.
      await clearForeignComposerText(agentName, pane, target, prompt, dialect);
      if (dialect === "codex") {
        const ready = await waitForCodexPromptReady(agentName, pane);
        busyAtSend = Boolean(ready?.busy);
        // Persist only provisional ownership before the first pane write.
        // A crash here must fence a duplicate paste, but the broker may not
        // call this an exact draft until the live composer proves it below.
        if (onPasteStarted) await onPasteStarted();
      }
      if (promptRequiresAtomicPaste(prompt)) {
        await pastePrompt({ tmux: t, target, prompt, sleep: wait });
      } else {
        await t.sendLiteral(target, prompt);
        await wait(1000);
      }
      // Durable ownership follows the completed pane write, not a later TUI
      // repaint. Composer scraping may help recovery, but it is never proof
      // that the payload was or was not delivered.
      if (onDrafted) await onDrafted();
    } else if (dialect === "codex") {
      busyAtSend = Boolean(await isBusy(agentName, pane));
    }

    if (dialect === "codex" && !exactDraft) {
      exactDraft = await waitForExactCodexDraft(agentName, pane, prompt);
      if (!exactDraft) {
        // Ratatui paint is advisory. The exact pane write above completed, so
        // a missing/torn composer frame cannot veto the submit attempt. JSONL
        // remains the only delivery acknowledgement after Enter.
        console.warn(`send ${agentName}:${pane}: exact Codex draft not visible; continuing to JSONL-verified submit`);
      }
    }
    // A previously queued turn can start during the paste/paint interval.
    // Re-sample immediately before Enter so the delivery layer treats our
    // prompt as one queued steering write instead of retrying it as idle.
    if (dialect === "codex" && !busyAtSend) {
      busyAtSend = Boolean(await isBusy(agentName, pane));
    }
    // The first callback persists an ambiguous at-most-once fence BEFORE the
    // physical key. If the process dies after Enter but before the second
    // callback, restart must never retype or claim NOT SENT.
    await submitWithDurableFence({
      onSubmitting,
      sendEnter: () => t.sendEnter(target),
      onSubmitted,
    });
    await maybeSendCodexSubmitEnter(agentName, pane, target, prompt, { notBeforeMs });
    await maybeRescueClaudeSubmit(agentName, pane, target, prompt);

    // Composer state is retained strictly as a transport hint for diagnostics
    // and bounded rescue. It never upgrades the submit attempt to delivery.
    let stillComposed = await promptAlreadyInComposer(agentName, pane, prompt, {
      ownedDraft: knownDrafted || exactDraft,
    });
    let releaseHint = stillComposed ? "draft-visible" : "single-empty";
    if (dialect === "codex" && !stillComposed) {
      let dir = null;
      try { dir = paneDir(agentConfig(agentName).dir, pane); } catch { /* JSONL unavailable */ }
      const release = await confirmCodexDraftReleased({
        prompt,
        initiallyComposed: stillComposed,
        observeComposed: () => promptAlreadyInComposer(agentName, pane, prompt, {
          ownedDraft: knownDrafted || exactDraft,
        }),
        submitted: async () => {
          if (!dir) return false;
          try { return isPromptInCodexJsonl(dir, prompt, { notBeforeMs }) === true; }
          catch { return false; }
        },
        sleep: wait,
      });
      stillComposed = !release.released;
      releaseHint = release.via;
    }
    const queued = dialect === "codex" && busyAtSend && exactDraft && !stillComposed;
    return {
      busyAtSend,
      queued,
      exactDraft,
      submitted: true,
      tuiHint: dialect === "codex" ? releaseHint : (stillComposed ? "draft-visible" : "composer-empty"),
    };
  }

  async function promptAlreadyInComposer(agentName, pane, prompt, { ownedDraft = false } = {}) {
    const head = prompt.trim().slice(0, 20);
    if (!head) return false;
    try {
      if ((await livePaneDialectName(agentName, pane)) === "codex") {
        const snapshot = await captureScreen(agentName, pane);
        return codexComposerContainsPrompt(snapshot, prompt)
          || (promptRequiresAtomicPaste(prompt)
            && (ownedDraft
              ? codexComposerMatchesOwnedDraft(snapshot, prompt)
              : codexComposerEndsWithPrompt(snapshot, prompt)));
      }
      const raw = await capturePane(agentName, pane, 15);
      // Composer lines render as "❯ text" (claude) / "› text" (codex) /
      // "> text" (legacy). COMPOSER_LINE_RE is built from dialect data —
      // a hardcoded [❯>] here missed codex's "›", so retries re-typed a
      // brief that was already sitting in the composer (ai:4 2026-07-08).
      // Requiring the marker keeps a prompt-head quoted in SCROLLBACK from
      // suppressing a legitimate first type-in.
      return raw.split("\n").slice(-5).some((l) => {
        const line = l.trim();
        return COMPOSER_LINE_RE.test(line) && line.includes(head);
      });
    } catch {
      return false;
    }
  }

  /**
   * Reconcile a durable `submitted` job whose JSONL echo is still absent.
   * This never types. It lets the broker distinguish a hidden busy queue from
   * an exact draft that resurfaced after an eaten Enter, or an idle empty
   * composer where the prior submission was genuinely lost.
   */
  async function promptTransportState(agentName, pane, prompt) {
    const dialect = await livePaneDialectName(agentName, pane);
    const busy = Boolean(await isBusy(agentName, pane).catch(() => true));
    if (dialect !== "codex") {
      const drafted = await promptAlreadyInComposer(agentName, pane, prompt);
      return {
        state: drafted ? "drafted" : (busy ? "hidden" : "empty-idle"),
        busy,
        dialect,
      };
    }

    const snapshot = await captureScreen(agentName, pane).catch(() => "");
    if (codexComposerContainsPrompt(snapshot, prompt)
        || (promptRequiresAtomicPaste(prompt) && codexComposerMatchesOwnedDraft(snapshot, prompt))) {
      return { state: "drafted", busy, dialect };
    }
    const composer = codexComposerText(snapshot);
    if (composer === null) return { state: "hidden", busy, dialect };
    if (composer === "") return { state: busy ? "empty-busy" : "empty-idle", busy, dialect };
    return { state: "foreign", busy, dialect, detail: composer.slice(0, 60) };
  }

  async function waitForExactCodexDraft(agentName, pane, prompt, timeoutMs = 2_500) {
    const deadline = Date.now() + timeoutMs;
    // An atomic paste can collapse to a "[Pasted Content N chars]" block whose
    // literal text is never visible. Delivery clears any foreign draft before
    // pasting, so once that block appears it is OUR prompt; accept it so Enter
    // submits (Codex expands the block on send).
    const mayCollapse = promptRequiresAtomicPaste(prompt);
    while (true) {
      const snapshot = await captureScreen(agentName, pane).catch(() => "");
      if (codexComposerContainsPrompt(snapshot, prompt)) return true;
      if (mayCollapse && codexComposerEndsWithPrompt(snapshot, prompt)) return true;
      if (mayCollapse && codexComposerHasPasteBlock(snapshot)) return true;
      if (Date.now() >= deadline) return false;
      await wait(200);
    }
  }

  /**
   * A previous failed delivery can leave ITS text sitting in the composer.
   * Typing on top of it corrupts both messages, and the NEXT send then
   * submits the merged garbage (ai:4 2026-07-08: a brief typed into an
   * interrupted codex TUI never submitted; 13 minutes later it went out as
   * "][ai:2, …"). Codex text is cleared only when JSONL proves it was already
   * submitted, or when an idle composer carries an agentmux-owned envelope;
   * arbitrary local drafts remain untouched.
   */
  async function clearForeignComposerText(agentName, pane, target, prompt, knownDialect = null) {
    const dialect = knownDialect || await livePaneDialectName(agentName, pane);
    let raw;
    try {
      raw = dialect === "codex"
        ? await captureScreen(agentName, pane)
        : await capturePane(agentName, pane, 15);
    } catch { return; }
    const head = prompt.trim().slice(0, 20);
    // Codex recovery prompts often share the same first 20 characters. Its
    // exact 160-character identity check owns idempotency; the old short-head
    // shortcut otherwise preserved a different stale recovery prompt forever.
    if (dialect === "codex" && codexComposerContainsPrompt(raw, prompt)) return;
    const stale = foreignComposerText(raw, dialect === "codex" ? null : head);
    if (!stale) return;
    const busy = await isBusy(agentName, pane);
    if (dialect === "codex") {
      let dir;
      try { dir = paneDir(agentConfig(agentName).dir, pane); } catch { return; }
      const submittedIdentity = codexPromptPrefixIdentity(dir, stale);
      const alreadySubmitted = submittedIdentity !== null;
      const agentmuxEnvelope = /^\[(?:from\s+[^\]]+|krasch-recovery)\]/i.test(stale);
      // Never erase a local draft. During work even an agentmux envelope can
      // be a legitimate queued message; only an already-submitted duplicate
      // is safe. When idle, a known agentmux envelope is failed-delivery
      // residue and can be recovered without touching human-authored prose.
      if (!alreadySubmitted && (busy || !agentmuxEnvelope)) return;
    } else if (busy) {
      return;
    }
    console.warn(
      `send ${agentName}:${pane}: clearing stale/duplicate composer text ("${stale.slice(0, 40)}…")`,
    );
    if (dialect === "codex") {
      const cleared = await clearCodexComposerDraft({
        capture: () => captureScreen(agentName, pane),
        clear: () => t.clearInputLine(target),
        ownsResurfacedDraft: submittedIdentity === null
          ? null
          : ({ composer }) => codexPromptPrefixIdentity(dir, composer) === submittedIdentity,
        sleep: wait,
      });
      if (!cleared.ok) {
        throw codexDeliveryBlocked(
          `Codex prompt delivery blocked: stale composer could not be cleared (${cleared.error})`,
        );
      }
    } else {
      await t.sendEscape(target);
      await wait(300);
    }
    try {
      appendEvent({
        ts: new Date().toISOString(),
        event: "composer_recovery",
        session: agentName,
        pane: Number(pane) || 0,
        busy,
        detail: stale.slice(0, 120),
      });
    } catch { /* recovery itself must not fail on diagnostics */ }
  }

  async function maybeSendCodexSubmitEnter(agentName, pane, target, prompt, {
    notBeforeMs = 0,
  } = {}) {
    const dialect = await livePaneDialectName(agentName, pane);
    if (dialect !== "codex") return;

    // Codex's node CLI accepts a tmux paste into the composer but routinely
    // misses the immediate Enter for long pasted prompts: the paste is still
    // rendering when our `send-keys Enter` arrives, and the keystroke gets
    // absorbed into the composer instead of submitting. A single rescue Enter
    // 750ms later isn't always enough on slower systems / very long prompts —
    // both the initial Enter and the rescue can be eaten.
    //
    // Strategy: poll the rollout jsonl (codex writes user_message there on
    // submit). If the prompt isn't recorded after a wait, send another Enter
    // and re-check. Cap retries so a stuck pane can't loop. jsonl is source
    // of truth — message only lands once Codex has actually submitted.
    let dir;
    try { dir = paneDir(agentConfig(agentName).dir, pane); } catch { dir = null; }

    const submitted = async () => {
      if (!dir) return null;            // unknown — caller falls back to retry
      try { return isPromptInCodexJsonl(dir, prompt, { notBeforeMs }) === true; }
      catch { return null; }
    };

    // Start the first confirmation look early enough that its 300ms repaint
    // window does not move the earliest rescue beyond the established 750ms
    // cadence. No key is sent before both observations complete.
    const rescueCadenceMs = 750;
    const observationGapMs = 300;
    const preObservationWaitMs = rescueCadenceMs - observationGapMs;
    await wait(preObservationWaitMs);
    if (await submitted() === true) return;

    // Up to 3 rescue attempts, spaced 750ms. Recovery requires two consistent
    // exact-draft observations and one final JSONL check immediately before
    // Enter. Busy is allowed only inside Codex's explicit queue editor.
    for (let attempt = 0; attempt < 3; attempt++) {
      const outcome = await rescueCodexSubmitIfConfirmed({
        prompt,
        submitted,
        observe: async () => {
          const [busy, snapshot] = await Promise.all([
            isBusy(agentName, pane).catch(() => true),
            captureScreen(agentName, pane).catch(() => ""),
          ]);
          return { busy, snapshot };
        },
        rescue: () => t.sendEnter(target),
        sleep: wait,
        observationGapMs,
      });
      if (!outcome.rescued) return;
      await wait(preObservationWaitMs);
      if (await submitted() === true) return;
    }
  }

  /**
   * Claude twin of the codex submit-rescue. A long paste + immediate Enter
   * can leave the text SITTING in the composer of an idle pane (paste still
   * rendering when Enter lands, or claude restarting under a huge session
   * jsonl — observed 2026-07-08: prompt pasted, echo-verified via composer
   * tail, then lost). Composer text on a BUSY pane is a legitimately queued
   * message and is left alone; only idle+still-in-composer gets rescued.
   * jsonl is the source of truth for "actually submitted".
   */
  async function maybeRescueClaudeSubmit(agentName, pane, target, prompt) {
    if (paneDialectName(agentName, pane) !== "claude") return;
    let dir;
    try { dir = paneDir(agentConfig(agentName).dir, pane); } catch { return; }

    const submitted = () => {
      try { return isPromptInJsonl(dir, prompt) === true; } catch { return false; }
    };

    await wait(750);
    if (submitted()) return;

    for (let attempt = 0; attempt < 2; attempt++) {
      if (await isBusy(agentName, pane)) return;       // queued behind a turn: fine
      const raw = await capturePane(agentName, pane, 15).catch(() => "");
      const tail = raw.split("\n").slice(-5).join("\n");
      if (!tail.includes(prompt.trim().slice(0, 20))) return; // not in composer
      await t.sendEnter(target);
      await wait(750);
      if (submitted()) return;
    }
  }

  // --- Orchestration ---

  async function ensureReady(agentName, pane) {
    const config = agentConfig(agentName);
    const isNew = !(await hasSession(agentName));

    await ensureSession(agentName);
    if (isNew) {
      await setupPanes(agentName, config.dir);
      await wait(2000);
    } else if ((await countPanes(agentName)) < (config.panes?.length || 0)) {
      // Session exists but is under-provisioned — e.g. a partial
      // tmux-resurrect restore left 2/8 panes. Rebuild the missing panes so a
      // plain `amux <agent>` self-heals the layout instead of just warning and
      // attaching. reconcileSession never respawns live claude/codex panes, so
      // running work is safe.
      await reconcileSession(agentName);
      await wait(1000);
    }
    await settleWindowSize(agentName, resolveTmuxLayout(config.layout));

    const target = `${agentName}:.${pane}`;
    const paneCmd = config.panes?.[pane]?.cmd || "bash";

    // startClaude/startCodex are idempotent (they return early when the process
    // is already up), but the wait-for-ready that follows is NOT: it sends a
    // reveal-Escape to surface the composer. Running that on a LIVE, working
    // pane re-Escaped a mid-thought Codex turn on EVERY delivery — the all-night
    // "Conversation interrupted" (2026-07-12). Only wait-for-ready when we
    // actually (re)start the process; a freshly started pane is idle, so its
    // reveal-Escape can never interrupt a turn.
    const wasRunning = await isAlreadyRunning(target);

    if (isClaudeCmd(paneCmd)) {
      // Resume-hint is emitted by bin/amux-hook.mjs on SessionStart
      // (1.20.52) — hook-context instead of a typed spawn prompt, so it
      // never wakes the pane with a false turn and never crosses panes.
      await startClaude(agentName, target, config.dir, pane);
      if (!wasRunning && !await waitForClaudeReady(target, agentName, pane)) {
        throw new Error(`Claude process started but its composer never became ready in ${agentName}:${pane}`);
      }
    } else if (isCodexCmd(paneCmd)) {
      // Codex panes use the same wait-for-ready + dismiss pattern as
      // claude. Resume-hint is skipped because startCodex resumes the exact
      // provenance-matched pane session (global `resume --last` is forbidden).
      await startCodex(agentName, target, config.dir, pane);
      if (!wasRunning) {
        const ready = await waitForCodexUiReady(target, agentName, pane);
        if (!ready) {
          throw new Error(`Codex process started but its composer never became ready in ${agentName}:${pane}`);
        }
      }
    }
  }

  /**
   * Rebuild every configured agent tmux session from agents.yaml.
   *
   * The bridge invokes this only after an explicit fleet-restart request.
   * All configured sessions are killed first so no half-old/half-new fleet
   * remains, then each agent is recreated independently. Coding panes resume
   * their durable Claude/Codex history through the normal ensureReady path;
   * shell and service panes are rebuilt by setupPanes.
   */
  async function restartFleet({ log = (message) => console.warn(message) } = {}) {
    const config = loadConfig();
    const fleet = Object.entries(config)
      // Native sessions live in the independent AMUX Code process and keep
      // their own engine session ids. A tmux fleet restart must never create
      // a shadow session for them or stop their active turns.
      .filter(([, cfg]) => cfg?.backend !== "native"
        && cfg?.dir && Array.isArray(cfg.panes) && cfg.panes.length > 0)
      .map(([name, cfg]) => ({ name, cfg }));
    const result = {
      ok: true,
      configured: fleet.map(({ name }) => name),
      stopped: [],
      recreated: [],
      codingPanes: 0,
      failures: [],
      resumeTargets: [],
    };
    const stopFailed = new Set();

    // A manually-run bridge can itself have been launched from one of the
    // configured coding tmux sessions. Killing that parent would also kill
    // this orchestrator halfway through the rebuild and strand the fleet.
    // Managed mode runs in the separate `amux` session and passes this gate.
    const ownerSocket = String(process.env.TMUX || "").split(",")[0];
    if (process.env.TMUX_PANE && ownerSocket === tmuxSocket) {
      const owner = await t.display(process.env.TMUX_PANE, "#{session_name}").catch(() => null);
      if (owner && fleet.some(({ name }) => name === owner)) {
        result.ok = false;
        result.failures.push({
          name: owner,
          stage: "guard",
          error: "bridge is hosted inside this configured session; start the bridge outside it or with amux serve --detach",
        });
        log(`fleet restart blocked: bridge is hosted inside ${owner}`);
        return result;
      }
    }

    result.resumeTargets = await tuiRecovery.interruptedFleetTargets(fleet, log);
    const serverHold = await createTmuxServerHold(t, result.configured);

    // Finish the destructive phase before creating anything. If one kill
    // fails, leave that session untouched and skip its rebuild rather than
    // typing startup commands into a still-live layout.
    for (const { name } of fleet) {
      try {
        if (await hasSession(name)) {
          await t.killSession(name);
          result.stopped.push(name);
        }
      } catch (err) {
        stopFailed.add(name);
        result.failures.push({ name, stage: "stop", error: err.message });
        log(`fleet restart: could not stop ${name}: ${err.message}`);
      }
    }

    // Recreate independent sessions with bounded parallelism. Unbounded
    // startup loaded every large transcript at once and made healthy panes
    // miss their readiness deadlines on a saturated host.
    const starts = await mapWithConcurrency(fleet, 2, async ({ name, cfg }) => {
      if (stopFailed.has(name)) return null;
      const codingPanes = cfg.panes
        .map((paneConfig, index) => isAgentCmd(paneConfig?.cmd) ? index : -1)
        .filter((index) => index >= 0);
      try {
        await ensureReady(name, codingPanes[0] ?? 0);
        if (codingPanes.length > 1) {
          await mapWithConcurrency(codingPanes.slice(1), 4, (pane) => ensureReady(name, pane));
        }
        return { name, codingPanes: codingPanes.length };
      } catch (err) {
        log(`fleet restart: could not recreate ${name}: ${err.message}`);
        return { name, codingPanes: 0, error: err.message };
      }
    });
    await serverHold.release().catch((err) =>
      log(`fleet restart: could not release ${serverHold.name}: ${err.message}`));

    for (const start of starts) {
      if (!start) continue;
      if (start.error) result.failures.push({ name: start.name, stage: "start", error: start.error });
      else {
        result.recreated.push(start.name);
        result.codingPanes += start.codingPanes;
      }
    }
    result.ok = result.failures.length === 0 && result.recreated.length === fleet.length;
    return result;
  }

  async function sendOnly(agentName, prompt, pane, options = {}) {
    await ensureReady(agentName, pane);
    return sendPrompt(agentName, prompt, pane, options);
  }

  async function sendAndWait(agentName, prompt, pane) {
    // wasStarting drives the post-send wait below (claude takes longer to
    // first-turn after fresh spawn).
    const wasStarting = !(await isAlreadyRunning(`${agentName}:.${pane}`));
    await ensureReady(agentName, pane);
    await sendPrompt(agentName, prompt, pane);

    await wait(wasStarting ? 8000 : 3000);

    const deadline = Date.now() + timeout;
    let sawWorking = false;
    let idleStreak = 0;

    while (Date.now() < deadline) {
      await exitCopyMode(`${agentName}:.${pane}`);
      const busy = await isBusy(agentName, pane);

      if (busy) { sawWorking = true; idleStreak = 0; }
      else {
        idleStreak += 2;
        if (sawWorking && idleStreak >= 2) break;
        if (!sawWorking && idleStreak >= 4) break;
      }
      await wait(2000);
    }

    await dismissBlockingPrompt(`${agentName}:.${pane}`);
    return getResponse(agentName, pane);
  }

  // --- Progress timer (thin wrapper around core/progress.mjs) ---

  function startProgressTimer(send, agentName, pane, opts = {}) {
    return createProgressTimer({
      send,
      getSegments: () => getResponseSegments(agentName, pane),
      capturePane: async () => {
        try {
          return await t.capture(`${agentName}:.${pane}`, { lines: 10 });
        } catch (err) {
          console.warn(`progress capturePane failed: ${err.message}`);
          return null;
        }
      },
    }, opts);
  }

  // --- Context ---

  /**
   * Get { percent, tokens } for a pane. Dispatches to the right session
   * store based on the pane's configured cmd (claude vs codex).
   */
  function getContextPercent(agentName, pane = 0) {
    try {
      const config = agentConfig(agentName);
      const dir = paneDir(config.dir, pane);
      const dialect = paneDialectName(agentName, pane);
      return getContextPercentByDialect(dir, dialect);
    } catch (err) {
      console.warn(`getContextPercent(${agentName}) failed: ${err.message}`);
      return null;
    }
  }

  /**
   * Pane-first context read: prefer the percent Claude Code itself renders
   * (status block or custom statusline) over recomputed jsonl math. The two
   * disagree near the limit — jsonl math divides by the RAW model window
   * while Claude Code measures against usable-space-before-autocompact
   * (2026-06-10 incident: 77% vs 92% on the same pane) — and Claude Code's
   * number is the one its own compaction acts on. Falls back to the jsonl
   * path when the pane shows no usable numbers (capture failed, tiny pane).
   */
  async function getContext(agentName, pane = 0) {
    try {
      if (paneDialectName(agentName, pane) === "claude") {
        const config = agentConfig(agentName);
        const dir = paneDir(config.dir, pane);
        const content = await capturePane(agentName, pane, 100);
        const fromPane = getContextFromPane(content, dir);
        if (fromPane) return fromPane;
      }
    } catch { /* fall through to jsonl */ }
    return getContextPercent(agentName, pane);
  }

  // --- Low-level (exposed for CLI) ---

  async function sendEscape(agentName, pane) {
    await t.sendEscape(`${agentName}:.${pane}`);
  }

  /** Open Codex's non-interrupting queue composer while a turn is working. */
  async function sendTab(agentName, pane) {
    await t.sendKeys(`${agentName}:.${pane}`, "Tab");
  }

  async function clearInputLine(agentName, pane) {
    await t.clearInputLine(`${agentName}:.${pane}`);
  }

  /** Bare Enter into a pane: verified slash-command submission primitive. */
  async function sendEnter(agentName, pane) {
    await t.sendEnter(`${agentName}:.${pane}`);
  }

  /**
   * Literal keystrokes WITHOUT a trailing Enter. TUI-driving primitive for
   * flows that interleave typing with capture verification (/status).
   */
  async function typeLiteral(agentName, text, pane) {
    await t.sendLiteral(`${agentName}:.${pane}`, text);
  }

  /**
   * Temporarily give a TUI enough rows to render a complete status surface.
   * Returns true only when this call changed tmux state; restorePaneZoom uses
   * that receipt so an already-zoomed human layout is never toggled away.
   */
  async function zoomPaneForPicker(agentName, pane) {
    const target = `${agentName}:.${pane}`;
    const wasZoomed = await t.paneZoomed(target);
    const previousActivePaneId = await t.activePaneId(target);
    const targetPaneId = await t.paneId(target);
    if (wasZoomed && previousActivePaneId === targetPaneId) {
      return { changed: false, wasZoomed, previousActivePaneId, targetPaneId };
    }
    // A tmux window can already be zoomed to a DIFFERENT pane. `resize -Z`
    // would otherwise merely unzoom it and leave our small target hidden.
    if (wasZoomed) await t.togglePaneZoom(target);
    await t.selectPane(target);
    await t.togglePaneZoom(target);
    return { changed: true, wasZoomed, previousActivePaneId, targetPaneId };
  }

  async function restorePaneZoom(agentName, pane, receipt) {
    if (!receipt) return;
    const target = `${agentName}:.${pane}`;
    // Backward-compatible boolean receipt for injected/older callers.
    if (typeof receipt === "boolean") {
      if (receipt && await t.paneZoomed(target)) await t.togglePaneZoom(target);
      return;
    }
    if (!receipt.changed) return;
    if (await t.paneZoomed(target)) await t.togglePaneZoom(target);
    if (receipt.previousActivePaneId) await t.selectPane(receipt.previousActivePaneId);
    if (receipt.wasZoomed && receipt.previousActivePaneId) {
      await t.togglePaneZoom(receipt.previousActivePaneId);
    }
  }

  async function paneHistorySize(agentName, pane) {
    const value = await t.display(`${agentName}:.${pane}`, "#{history_size}");
    const size = Number(value);
    return Number.isFinite(size) ? size : null;
  }

  async function checkAgent(agentName) {
    if (!(await hasSession(agentName))) throw new Error(`No session: ${agentName}`);
    if (!(await isAlreadyRunning(`${agentName}:.0`))) throw new Error(`Claude not running in ${agentName}`);
  }

  const tuiRecovery = createTuiStallRecovery({
    tmux: t,
    state,
    delay: wait,
    configFor: agentConfig,
    paneDirectory: paneDir,
    isPaneDead,
    respawnPane,
    isAlreadyRunning,
    resolveSessionFlag,
    isBusy,
    promptTransportState,
    restartCodex,
  });

  return {
    ensureReady, sendAndWait, sendOnly,
    getResponse, getResponseSegments, getResponseStream, getResponseStreamWithRaw, hasResponseForPrompt, isBusy,
    promptTransportState,
    capturePane, captureScreen, capturePromptEchoCursor, captureSlashReceiptCursor, waitForSlashReceipt, sendEscape, sendTab, clearInputLine, sendEnter, typeLiteral, zoomPaneForPicker, restorePaneZoom, paneHistorySize,
    dismissBlockingPrompt, waitForPromptEcho,
    startProgressTimer, getContextPercent, getContext, checkAgent, reconcileSession, paneProcessState: tuiRecovery.paneProcessState,
    sanitizeTmuxGlobalEnv, restartCodex, restartPaneExact, restartFleet,
  };
}
