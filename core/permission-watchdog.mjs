// Recognition and policy for Claude Code permission prompts that block a pane.
// Pure functions; the channel in channels/permission-watchdog.mjs does the I/O.
//
// Origin (2026-09-12): a paid Modal training run sat 21 minutes behind
// "Dangerous rm operation on possibly-empty variable path" because bypass
// mode still asks for that one, the pane cannot answer itself and nothing in
// amux read the screen. Mattias: "får inte hända igen".

import { createHash } from "node:crypto";
import { bashPermissionDecision } from "./rm-target-guard.mjs";
import { resolveRmTarget, unsafeRmPath } from "./rm-target-resolution.mjs";
import { parseJsonlWindow } from "./jsonl-window.mjs";

/**
 * WHAT: Defines watchdog timing: fast answers for safe rm, slow human alerts.
 * WHY: Keeps a safe prompt from blocking a pane while a real decision waits for Mattias.
 */
export const DEFAULT_PERMISSION_WATCHDOG_CONFIG = {
  enabled: true,
  autoAnswer: true,
  pollMs: 10_000,
  answerAgeMs: 10_000,
  promptAgeMs: 120_000,
  humanAgeMs: 600_000,
};

/** WHAT: Checks the observed permission mode. WHY: Keeps other modes from receiving automatic answers. */
export function permissionModeAllowsAnswer(mode) {
  return mode === "bypassPermissions";
}

/** WHAT: Reads the session's latest permission mode. WHY: Keeps stale or foreign sessions from authorizing an answer. */
export function sessionPermissionMode(path, sessionId) {
  if (!path || !sessionId) return null;
  const rows = parseJsonlWindow(path, { initialBytes: 256 * 1024, maxBytes: 8 * 1024 * 1024,
    enough: (events) => events.some((e) => e.type === "permission-mode" && e.sessionId === sessionId) });
  return rows.filter((e) => e.type === "permission-mode" && e.sessionId === sessionId).at(-1)?.permissionMode || null;
}

/**
 * WHAT: Parses watchdog switches and delays from the environment.
 * WHY: Keeps tuning in env from requiring a code change.
 */
export function parsePermissionWatchdogConfig(env = process.env) {
  const int = (v, d) => { const n = parseInt(v ?? "", 10); return Number.isFinite(n) && n > 0 ? n : d; };
  const d = DEFAULT_PERMISSION_WATCHDOG_CONFIG;
  return {
    enabled: env.AMUX_PERMISSION_WATCHDOG_ENABLED !== "false",
    autoAnswer: env.AMUX_PERMISSION_WATCHDOG_AUTO_ANSWER !== "false",
    pollMs: int(env.AMUX_PERMISSION_WATCHDOG_POLL_MS, d.pollMs),
    answerAgeMs: int(env.AMUX_PERMISSION_WATCHDOG_ANSWER_AGE_MS, d.answerAgeMs),
    promptAgeMs: int(env.AMUX_PERMISSION_WATCHDOG_PROMPT_AGE_MS, d.promptAgeMs),
    humanAgeMs: int(env.AMUX_PERMISSION_WATCHDOG_HUMAN_AGE_MS, d.humanAgeMs),
  };
}

const strip = (s) => String(s || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");
const compactPaneRows = (rows) => rows.map((x) => x.l.replace(/^\s*│\s?/u, "")).join("").replace(/\s+/gu, "");

/** Finds one active Yes/No modal even when Claude wraps its controls in a narrow pane. */
function permissionControls(lines) {
  const nonEmpty = lines.map((l, i) => ({ l, i })).filter((x) => x.l.trim());
  const tail = nonEmpty.slice(-14);
  let question = null;
  for (let i = tail.length - 1; i >= 0 && !question; i--) {
    if (!/^\s*(?:│\s*)?Do\b/u.test(tail[i].l)) continue;
    for (let j = i; j < Math.min(i + 4, tail.length); j++) {
      if (compactPaneRows(tail.slice(i, j + 1)).includes("Doyouwanttoproceed?")) {
        question = { start: tail[i].i, end: tail[j].i };
        break;
      }
    }
  }
  if (!question) return null;
  const afterQuestion = tail.filter((x) => x.i > question.end);
  const controls = compactPaneRows(afterQuestion);
  const yes = controls.indexOf("1.Yes");
  const no = controls.indexOf("2.No", yes + 1);
  const cancel = controls.indexOf("Esctocancel", no + 1);
  if (yes < 0 || no < 0 || cancel < 0) return null;
  let cancelEnd = -1;
  for (let i = 0; i < afterQuestion.length; i++) {
    if (compactPaneRows(afterQuestion.slice(0, i + 1)).includes("Esctocancel")) {
      cancelEnd = afterQuestion[i].i;
      break;
    }
  }
  if (lines.slice(cancelEnd + 1).some((l) => /^\s*[❯›>]\s*$/u.test(l) || /^\s*[❯›>]\s+\S/u.test(l))) return null;
  const visibleOptions = afterQuestion.map((x) => x.l.trim()).filter((l) => /^(?:❯\s*)?\d+\.\s+\S/u.test(l));
  const optionWrapped = !visibleOptions.some((o) => /^(?:❯\s*)?1\.\s+Yes\b/u.test(o))
    || !visibleOptions.some((o) => /^(?:❯\s*)?2\.\s+No\b/u.test(o));
  return {
    askIdx: question.start,
    options: optionWrapped ? ["❯ 1. Yes", "2. No"] : visibleOptions,
    wrapped: question.start !== question.end || optionWrapped || !afterQuestion.some((x) => /Esc to cancel/u.test(x.l)),
  };
}

/**
 * WHAT: Extracts the active Claude Code permission prompt at a pane's bottom.
 * WHY: Keeps answered prompts in scrollback from being answered again.
 */
export function detectPermissionPrompt(paneText) {
  // Requires the question, numbered options and "Esc to cancel" in the last
  // lines with no composer below. Wrapped display text is never proof for auto-answer.
  const lines = strip(paneText).split(/\r?\n/).map((l) => l.trimEnd());
  const controls = permissionControls(lines);
  if (!controls) return null;
  const { askIdx, options } = controls;
  const unbox = (l) => l.replace(/^\s*│\s?/u, "").trim();
  // Newer Claude Code draws the reason inside the box and wraps its target onto
  // the next box line; older builds print it as a plain line under the box.
  const boxedReasonIdx = lines.findLastIndex((l, i) => i < askIdx && /^\s*│\s*Dangerous\b/u.test(l)
    && compactPaneRows(lines.slice(i, i + 3).map((text) => ({ l: text }))).startsWith("Dangerousrmoperation"));
  const bodyEnd = boxedReasonIdx >= 0 ? boxedReasonIdx : askIdx;
  // Command box: lines starting with "│" above the question; the box may carry
  // a trailing description line ("Relaunch the v8 training ...").
  const commandLines = [];
  for (let i = bodyEnd - 1, found = false; i >= 0; i--) {
    if (/^\s*│/u.test(lines[i])) {
      found = true;
      commandLines.unshift(lines[i].replace(/^\s*│\s?/u, ""));
    } else if (found) {
      break;
    }
  }
  const command = commandLines.join("\n").trim();
  // Reason: the boxed reason with its wrapped lines, else the last non-empty,
  // non-box, non-title line before the question.
  const reason = boxedReasonIdx >= 0
    ? lines.slice(boxedReasonIdx, askIdx).filter((l) => /^\s*│/u.test(l)).map(unbox).filter(Boolean).join(" ")
    : lines.slice(0, askIdx).map((l) => l.trim()).filter((l) => l && !/^│/u.test(l) && !/^Bash command$/u.test(l) && !/^[─┌┐└┘]+$/u.test(l)).at(-1) || "";
  const boxedLines = lines.slice(Math.max(0, bodyEnd - commandLines.length), askIdx).filter((l) => /^\s*│/u.test(l));
  const narrowBox = boxedLines.length > 1 && Math.max(...boxedLines.map((l) => l.length)) <= 48;
  const screenWrapped = controls.wrapped || narrowBox;
  const signature = createHash("sha256")
    .update(JSON.stringify({ reason, command, options, screenWrapped }))
    .digest("hex");
  return { signature, reason, command, options, screenWrapped };
}

/**
 * WHAT: Resolves the one step a blocking prompt has earned at its current age.
 * WHY: Keeps a prompt from reaching Mattias before its owner has had the chance.
 */
export function nextPromptStep({ ageMs, answerable, hasOrchestrator, state, config }) {
  if (answerable && !state.answered && ageMs >= config.answerAgeMs) return "answer";
  if (!state.orchestratorNotified && !state.humanNotified && ageMs >= config.promptAgeMs) {
    return hasOrchestrator ? "orchestrator" : "human";
  }
  if (state.orchestratorNotified && !state.humanNotified && ageMs >= config.humanAgeMs) return "human";
  return null;
}

/**
 * WHAT: Formats one durable line about what the watchdog did with a prompt.
 * WHY: Keeps "did it answer, or is it still waiting?" answerable from a file.
 */
export function permissionDecisionLine({ at, paneKey, sessionId = null, signature, action, reason = "", why = "" }) {
  return `${JSON.stringify({
    ts: new Date(at).toISOString(),
    pane: paneKey,
    sessionId,
    signature: String(signature || "").slice(0, 16),
    action,
    reason: String(reason).slice(0, 300),
    why: String(why).slice(0, 300),
  })}\n`;
}

/**
 * WHAT: Formats the currently blocked panes as a snapshot for `amux prompts`.
 * WHY: Keeps a prompt's real age readable outside the bridge process.
 */
export function openPromptsSnapshot(at, open) {
  return `${JSON.stringify({
    ts: new Date(at).toISOString(),
    prompts: open.map((p) => ({
      pane: p.paneKey,
      signature: String(p.signature || "").slice(0, 16),
      firstSeenAt: new Date(p.firstSeenAt).toISOString(),
      reason: p.reason,
      decision: p.decision,
      orchestratorNotified: p.orchestratorNotified,
      humanNotified: p.humanNotified,
      answered: p.answered,
    })),
  }, null, 2)}\n`;
}

const RM_REASON = /^Dangerous rm operation on (possibly-empty variable path(?: inside command substitution)?|statically-unresolvable target):\s*(.+)$/su;
// Claude Code 2.1.28x names one target and then quotes the rm and a hint: "$S/$2 in `rm -rf $S/$2` (bind $2 ...)".
const QUOTED_RM = /^(.+?) in `[^`]*` \(.*\)$/su;
const notify = (why) => ({ action: "notify", why });

/**
 * WHAT: Checks whether a permission prompt may be answered yes without a human.
 * WHY: Keeps safe rm prompts from blocking panes and every other prompt with Mattias.
 */
export function classifyPermissionPrompt({ reason = "", command = "", screenWrapped = false } = {}, { home }) {
  // Claude Code asks about rm targets it cannot resolve statically even in bypass
  // mode (Mattias 2026-09-14: amux approves rm automatically). A target is safe once
  // it resolves to a deep literal path that is not home, a top folder in home or on
  // a drive. Returns { action: "answer", keys, why } or
  // { action: "notify", why }.
  if (screenWrapped) return notify("the permission prompt is wrapped on screen, so its rm target cannot be proven");
  const m = RM_REASON.exec(reason.trim());
  if (!m && /^Dangerous rm operation/u.test(reason.trim())) {
    if (!command.trim()) return notify("the command is not visible");
    const decision = bashPermissionDecision(command, home);
    return decision.behavior === "allow" ? { action: "answer", keys: "1", why: "the visible Bash command is allowed" } : notify(decision.message);
  }
  if (!m) return notify("not a Claude Code dangerous-rm check");
  if (/inside command substitution/u.test(m[1])) return notify("rm target comes from command substitution");
  const quoted = QUOTED_RM.exec(m[2].trim());
  // one named target holds no space unless a narrow pane broke it across lines
  if (quoted && /\s/u.test(quoted[1].trim())) return notify(`the rm target is broken across screen lines: ${quoted[1].trim()}`);
  const targets = quoted ? [quoted[1].trim()] : m[2].trim().split(/\s+/u);
  const paths = [];
  for (const target of targets) {
    const resolved = resolveRmTarget(target, command, home);
    if (resolved.why) return notify(resolved.why);
    for (const path of resolved.paths) {
      const unsafe = unsafeRmPath(path, home);
      if (unsafe) return notify(unsafe);
      paths.push(path);
    }
  }
  return { action: "answer", keys: "1", why: `the rm targets are sufficiently deep (${paths.join(", ")})` };
}

/**
 * WHAT: Formats the message a pane's owner or Mattias gets about a stuck prompt.
 * WHY: Keeps the reader from having to open tmux to see what is being asked.
 */
export function formatPermissionAlert({ paneKey, ageMs, reason, command, why }) {
  const cmd = String(command || "").split("\n").slice(0, 8).join("\n");
  return [
    `Pane ${paneKey} has waited ${Math.round(ageMs / 60_000)} min on a yes/no prompt that amux does not answer itself (${why}).`,
    reason ? `Reason: ${reason}` : "",
    cmd ? `Command:\n${cmd}` : "",
    `Answer in the pane: amux ${paneKey.replace(":", " -p ")} -- 1   (or 2 for no)`,
  ].filter(Boolean).join("\n");
}
