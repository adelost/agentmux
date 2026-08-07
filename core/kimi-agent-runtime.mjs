// Kimi-specific TUI lifecycle and durable transport helpers.

import { existsSync } from "node:fs";
import { esc, stripAnsi } from "../lib.mjs";
import { buildKimiLaunchCommand } from "./agent-launch-command.mjs";
import { KIMI } from "./dialects.mjs";
import {
  effectiveKimiHome,
  ensureKimiWorkspaceTrusted,
} from "./kimi-workspace-trust.mjs";
import {
  captureKimiPromptEchoCursor,
  extractFromKimiJsonl,
  getContextFromKimiJsonl,
  isBusyFromKimiJsonl,
  isPromptInKimiJsonl,
  latestKimiSessionIdentity,
} from "./kimi-jsonl-reader.mjs";
import { isKimiPaneCommand } from "./tui-stall-recovery.mjs";
import { createRuntimeProfileResolver } from "./runtime-account-profiles.mjs";

const PROMPT_READY_TIMEOUT_MS = 15_000;
const KIMI_STEER_QUEUE_TIMEOUT_MS = 5_000;
// Never hammer a dialog: at most one modal answer per wait loop this often,
// and never more than this many per wait. Both known dialogs preselect their
// first option, so a single Enter is the whole answer.
const KIMI_MODAL_ANSWER_INTERVAL_MS = 2_000;
const KIMI_MODAL_ANSWER_MAX = 3;

/** WHAT: Names the internal ingest-probe prompt prefix. WHY: Prevents probe turns from reaching Discord mirrors. */
export const AMUX_PROBE_PREFIX = "AMUX-PROBE ";

/** WHAT: Checks Kimi's empty plain or bordered composer. WHY: Prevents TUI box glyphs from hiding a ready input boundary. */
export function isKimiComposerReady(snapshot) {
  return KIMI.promptLineRe.test(stripAnsi(snapshot));
}

/**
 * WHAT: Names the Kimi dialog holding a pane, or null. WHY: Kimi's startup
 * ("Trust this folder?") and send-time ("Cache expired") dialogs replace the
 * editor, so the boxed composer vanishes — that absence is the discriminator
 * that keeps turn prose quoting these titles from reading as a modal.
 * Recognition data lives in the dialect registry (KIMI.modals).
 */
export function kimiModalForScreen(snapshot) {
  const text = stripAnsi(snapshot || "");
  const lines = text.split("\n").map((line) => line.trim()).filter(Boolean);
  const tail = lines.slice(-15);
  if (tail.some((line) => KIMI.promptLineRe.test(line))) return null;
  const tailText = tail.join("\n");
  const modal = (KIMI.modals || []).find((entry) => entry.re.test(tailText));
  return modal ? modal.id : null;
}

// A composer line holding only Kimi's collapsed atomic-paste marker. The
// full pasted text is not visible in that state; the marker is. Mirrors the
// TUI's `[paste #N]` / `+N lines` / `N chars` forms (see pi-tui editor).
const KIMI_COLLAPSED_PASTE_COMPOSER_RE = /^\s*(?:[│┃]\s*)?>\s*\[paste #\d+(?: (?:\+\d+ lines|\d+ chars))?\]\s*(?:[│┃]\s*)?$/mu;

/** WHAT: Checks a composer snapshot for Kimi's collapsed paste marker. WHY: Prevents recovery from re-pasting or fencing an owned collapsed draft. */
export function kimiComposerHasCollapsedPaste(snapshot) {
  return KIMI_COLLAPSED_PASTE_COMPOSER_RE.test(stripAnsi(snapshot));
}

/** WHAT: Defines Kimi Wire operations. WHY: Keeps engine dispatch separate from journal internals. */
export const kimiJournal = Object.freeze({
  capturePromptCursor: captureKimiPromptEchoCursor,
  context: getContextFromKimiJsonl,
  extract: extractFromKimiJsonl,
  isBusy: isBusyFromKimiJsonl,
  promptAccepted: isPromptInKimiJsonl,
});

/** WHAT: Builds Kimi pane lifecycle operations. WHY: Keeps agent orchestration below its legacy size cap. */
export function createKimiAgentRuntime({
  t,
  state,
  wait,
  paneDir,
  agentConfig,
  isBusy,
  isPaneDead,
  respawnPane,
  isAlreadyRunning,
  isShellProcess,
  captureScreen,
  promptAlreadyInComposer,
}) {
  const runtimeProfileFor = createRuntimeProfileResolver({ state, configFor: agentConfig });
  function blocked(message) {
    const error = new Error(message);
    error.code = "AMUX_DELIVERY_BLOCKED";
    return error;
  }

  /**
   * WHAT: Answers a known Kimi dialog with its preselected first option
   * (Enter). WHY: a CONSCIOUS workaround, written down as such on Mattias's
   * 2026-08-07 directive — the real fix for "Trust this folder?" is the
   * launch-time pre-seed above; this backstop exists for upstream store drift
   * and for the cache-expiry hint, which cannot be pre-seeded. What Enter
   * selects: "Trust" — it only ever trusts the pane's own launch directory,
   * which the operator already trusted by launching the pane there — and
   * "Compact and continue", the fleet's standing manual answer and the
   * product's cheapest keep-topic option. Rate-limited and capped so an
   * unknown dialog never gets hammered.
   */
  function createKimiModalAnswerer(target) {
    let lastAnswerAt = 0;
    let answers = 0;
    const seen = new Set();
    async function answerKimiModal(screen) {
      const modal = kimiModalForScreen(screen);
      if (!modal) return null;
      seen.add(modal);
      const now = Date.now();
      if (answers < KIMI_MODAL_ANSWER_MAX && now - lastAnswerAt >= KIMI_MODAL_ANSWER_INTERVAL_MS) {
        lastAnswerAt = now;
        answers++;
        console.warn(`kimi modal "${modal}" on ${target}; answering with its preselected first option (Enter)`);
        await t.sendKeys(target, "Enter").catch(() => {});
      }
      return modal;
    }
    answerKimiModal.seen = () => [...seen];
    return answerKimiModal;
  }

  async function startKimi(name, target, rootDir, pane = 0, launch = null) {
    if (await isPaneDead(target)) await respawnPane(target);
    if (await isAlreadyRunning(target)) return;
    const dir = paneDir(rootDir, pane);
    const paneConfig = agentConfig(name).panes?.[pane] || {};
    const profile = launch?.profile || runtimeProfileFor?.(name, pane, "kimi") || null;
    const discovered = latestKimiSessionIdentity(dir);
    const resumeSessionId = launch?.resumeSessionId
      || paneConfig.resumeSessionId
      || discovered?.sessionId
      || null;
    const model = launch?.model || paneConfig.model || "kimi-code/k3";
    const executable = process.env.KIMI_CODE_BIN
      || `${process.env.HOME}/.kimi-code/bin/kimi`;
    if (!existsSync(executable)) {
      throw new Error(`Kimi Code CLI is not installed at ${executable}`);
    }
    const cmd = buildKimiLaunchCommand({
      executable,
      model,
      resumeSessionId,
      allowFreshBootstrap: !resumeSessionId,
      profileHome: profile?.home || null,
    });
    // Pre-seed kimi-code's workspace-trust store for the pane's own launch
    // dir so the "Trust this folder?" startup modal never blocks a restart.
    // The store is the product's own (see core/kimi-workspace-trust.mjs for
    // the verified format); a failure here only means the modal answerer in
    // the wait loops below stays the backstop — the launch must proceed.
    const trust = ensureKimiWorkspaceTrusted({
      kimiHome: effectiveKimiHome({ profileHome: profile?.home || null }),
      workDir: dir,
    });
    if (trust.status === "error") {
      console.warn(`kimi workspace-trust pre-seed failed for ${dir}: ${trust.error} (launch continues)`);
    }
    await t.runShell(target, `cd ${esc(dir)} && ${cmd}`);
    await wait(1500);
  }

  async function waitForKimiUiReady(
    target,
    agentName,
    pane,
    timeoutMs = PROMPT_READY_TIMEOUT_MS,
  ) {
    const answerModal = createKimiModalAnswerer(target);
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const [command, screen] = await Promise.all([
        t.currentCommand(target).catch(() => ""),
        t.captureScreen(target).catch(() => ""),
      ]);
      if (/^(kimi|kimi-code)$/u.test(command) && isKimiComposerReady(screen)) return true;
      await answerModal(screen);
      await wait(250);
    }
    const modals = answerModal.seen();
    console.warn(`waitForKimiUiReady(${agentName}:${pane}) stalled before ${timeoutMs}ms${modals.length ? ` — modal(s) seen: ${modals.join(", ")}` : ""}`);
    return false;
  }

  async function restartKimi(agentName, pane, launch = null) {
    const config = agentConfig(agentName);
    const paneCmd = config.panes?.[pane]?.cmd || "";
    if (!isKimiPaneCommand(paneCmd)) throw new Error(`${agentName}:${pane} is not a Kimi pane`);
    if (await isBusy(agentName, pane)) throw new Error(`${agentName}:${pane} is still working`);
    const target = `${agentName}:.${pane}`;
    const dir = paneDir(config.dir, pane);
    const identity = latestKimiSessionIdentity(dir);
    if (!identity?.sessionId) {
      throw new Error(`Kimi continuity blocked for ${agentName}:${pane}: exact persisted session not found`);
    }
    await t.respawnPane(target, { kill: true, cwd: dir });
    const shellDeadline = Date.now() + 5_000;
    while (Date.now() < shellDeadline) {
      if (isShellProcess(await t.currentCommand(target).catch(() => ""))) break;
      await wait(100);
    }
    const model = config.panes?.[pane]?.model || "kimi-code/k3";
    await startKimi(agentName, target, config.dir, pane, {
      ...(launch || {}),
      resumeSessionId: identity.sessionId,
      model,
    });
    if (!await waitForKimiUiReady(target, agentName, pane)) {
      throw new Error(`Kimi process started but its composer never became ready in ${agentName}:${pane}`);
    }
    return { ok: true, model, sessionId: identity.sessionId };
  }

  async function waitForKimiPromptReady(agentName, pane) {
    const target = `${agentName}:.${pane}`;
    const answerModal = createKimiModalAnswerer(target);
    const deadline = Date.now() + PROMPT_READY_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const [busy, snapshot] = await Promise.all([
        isBusy(agentName, pane).catch(() => true),
        captureScreen(agentName, pane).catch(() => ""),
      ]);
      if (isKimiComposerReady(snapshot)) return { busy: Boolean(busy), snapshot };
      await answerModal(snapshot);
      await wait(250);
    }
    const modals = answerModal.seen();
    throw blocked(`Kimi prompt delivery timed out: composer is not ready${modals.length ? ` (modal held: ${modals.join(", ")})` : ""}`);
  }

  /**
   * WHAT: Queues an active-turn draft through Enter before steering it with Ctrl-S.
   * WHY: Kimi's Ctrl-S handler reads the editor's collapsed `[paste #…]` marker,
   * while Enter expands the original bracketed paste into its internal queue.
   */
  async function submitKimiPromptNow(target, { busy = false } = {}) {
    await t.sendKeys(target, "Enter");
    if (!busy) return;

    const deadline = Date.now() + KIMI_STEER_QUEUE_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const screen = await t.captureScreen(target).catch(() => "");
      if (isKimiComposerReady(screen)) {
        await t.sendKeys(target, "C-s");
        return;
      }
      await wait(50);
    }
    throw blocked(
      "Kimi prompt delivery blocked: Enter did not move the exact draft into Kimi's steer queue",
    );
  }

  async function maybeRescueKimiSubmit(agentName, pane, target, prompt, {
    notBeforeMs = 0,
  } = {}) {
    let dir;
    try { dir = paneDir(agentConfig(agentName).dir, pane); } catch { return; }
    const answerModal = createKimiModalAnswerer(target);
    const submitted = () => {
      try { return isPromptInKimiJsonl(dir, prompt, { notBeforeMs }) === true; }
      catch { return false; }
    };
    await wait(600);
    if (submitted()) return;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (await isBusy(agentName, pane).catch(() => true)) return;
      // A dialog (classically the cache-expiry hint on first send) hides the
      // composer; answer it instead of abandoning the rescue.
      const screen = await captureScreen(agentName, pane).catch(() => "");
      if (await answerModal(screen)) continue;
      if (!await promptAlreadyInComposer(agentName, pane, prompt)) return;
      if (submitted()) return;
      await t.sendEnter(target);
      await wait(600);
      if (submitted()) return;
    }
  }

  return {
    maybeRescueKimiSubmit,
    restartKimi,
    startKimi,
    submitKimiPromptNow,
    waitForKimiPromptReady,
    waitForKimiUiReady,
  };
}
