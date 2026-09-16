// Recognition and policy for Claude Code permission prompts that block a pane.
// Pure functions; the channel in channels/permission-watchdog.mjs does the I/O.
//
// Origin (2026-09-12): a paid Modal training run sat 21 minutes behind
// "Dangerous rm operation on possibly-empty variable path" because bypass
// mode still asks for that one, the pane cannot answer itself and nothing in
// amux read the screen. Mattias: "får inte hända igen".

import { createHash } from "node:crypto";

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

/**
 * WHAT: Extracts the active Claude Code permission prompt at a pane's bottom.
 * WHY: Keeps answered prompts in scrollback from being answered again.
 */
export function detectPermissionPrompt(paneText) {
  // Requires the question, numbered options and "Esc to cancel" in the last
  // lines with no composer below. Returns null or { signature, reason, command, options }.
  const lines = strip(paneText).split(/\r?\n/).map((l) => l.trimEnd());
  const nonEmpty = lines.map((l, i) => ({ l, i })).filter((x) => x.l.trim());
  const tail = nonEmpty.slice(-14);
  const tailText = tail.map((x) => x.l).join("\n");
  if (!/Do you want to proceed\?/u.test(tailText)) return null;
  const options = tail.map((x) => x.l.trim()).filter((l) => /^(?:❯\s*)?\d+\.\s+\S/u.test(l));
  if (!options.some((o) => /^(?:❯\s*)?1\.\s+Yes\b/u.test(o))) return null;
  if (!/Esc to cancel/u.test(tailText)) return null;
  // Anything after the option lines that looks like a composer prompt means the
  // dialog is gone and this is scrollback.
  const lastOptionIdx = Math.max(...tail.filter((x) => /^\s*(?:❯\s*)?\d+\.\s+\S/u.test(x.l)).map((x) => x.i));
  if (lines.slice(lastOptionIdx + 1).some((l) => /^\s*[❯›>]\s*$/u.test(l) || /^\s*[❯›>]\s+\S/u.test(l))) return null;

  const askIdx = lines.findLastIndex((l, i) => i <= lastOptionIdx && /Do you want to proceed\?/u.test(l));
  const unbox = (l) => l.replace(/^\s*│\s?/u, "").trim();
  // Newer Claude Code draws the reason inside the box and wraps its target onto
  // the next box line; older builds print it as a plain line under the box.
  const boxedReasonIdx = lines.findLastIndex((l, i) => i < askIdx && /^\s*│\s*Dangerous rm operation/u.test(l));
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
  const signature = createHash("sha256")
    .update(JSON.stringify({ reason, command, options }))
    .digest("hex");
  return { signature, reason, command, options };
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

const RM_REASON = /^Dangerous rm operation on (possibly-empty variable path(?: inside command substitution)?|statically-unresolvable target):\s*(.+)$/u;
const MIN_DEPTH = 3;
const notify = (why) => ({ action: "notify", why });

/**
 * WHAT: Checks whether a permission prompt may be answered yes without a human.
 * WHY: Keeps safe rm prompts from blocking panes and every other prompt with Mattias.
 */
export function classifyPermissionPrompt({ reason = "", command = "" } = {}, { home, holdsKeptFiles }) {
  // Claude Code asks about rm targets it cannot resolve statically even in bypass
  // mode (Mattias 2026-09-14: amux approves rm automatically). A target is safe once
  // it resolves to a deep literal path that is not home, a top folder in home or on
  // a drive, and holds nothing git keeps. Returns { action: "answer", keys, why } or
  // { action: "notify", why }.
  const m = RM_REASON.exec(reason.trim());
  if (!m) return notify("not a Claude Code dangerous-rm check");
  if (/inside command substitution/u.test(m[1])) return notify("rm target comes from command substitution");
  const paths = [];
  for (const target of m[2].trim().split(/\s+/u)) {
    const resolved = resolveRmTarget(target, command, home);
    if (resolved.why) return notify(resolved.why);
    const unsafe = unsafeRmPath(resolved.path, home, holdsKeptFiles);
    if (unsafe) return notify(unsafe);
    paths.push(resolved.path);
  }
  return { action: "answer", keys: "1", why: `rm-målen är djupa mappar utan filer som git behåller (${paths.join(", ")})` };
}

/** Resolves an rm target to its literal folder prefix: variables from literal
 * assignments in the same command, ~ as home, cut at the first glob. */
function resolveRmTarget(target, command, home) {
  let t = target.replace(/["']/gu, "");
  if (/\$\(|`/u.test(t)) return { why: "rm target comes from command substitution" };
  for (const [, name] of t.matchAll(/\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?/gu)) {
    const assign = new RegExp(`(?:^|[;\\n]|&&|\\|\\|)\\s*${name}=("?)(\\/[^\\s"';&|]+)\\1(?=\\s|;|$)`, "u").exec(command);
    if (!assign) return { why: `${name} is not assigned to a literal absolute path in the same command` };
    if (/\$/u.test(assign[2])) return { why: `${name} is assigned from another variable` };
    t = t.replace(new RegExp(`\\$\\{?${name}\\}?(?![A-Za-z0-9_])`, "gu"), assign[2]);
  }
  if (/\$/u.test(t)) return { why: `rm target is still a variable: ${target}` };
  if (t === "~" || t.startsWith("~/")) t = home + t.slice(1);
  const literal = t.split(/[*?[]/u)[0].replace(/\/+$/u, "");
  if (literal.startsWith("/")) return { path: literal };
  // A relative target is only as safe as the folder it runs in.
  const cd = [...command.matchAll(/(?:^|[;\n]|&&)\s*cd\s+("?)(\/[^\s"';&|]+)\1/gu)].at(-1);
  if (!cd) return { why: `relative rm target without a literal cd in the command: ${target}` };
  if (!literal || literal === ".") return { why: "rm target is the whole working directory" };
  return { path: `${cd[2].replace(/\/+$/u, "")}/${literal.replace(/^\.\//u, "")}` };
}

function unsafeRmPath(path, home, holdsKeptFiles) {
  const segments = path.split("/").filter((s) => s && s !== ".");
  if (segments.includes("..")) return `rm target climbs out with ..: ${path}`;
  if (segments.length < MIN_DEPTH) return `${path} is too close to the filesystem root`;
  const homeSegments = String(home || "").split("/").filter(Boolean);
  const underHome = homeSegments.length && homeSegments.every((s, i) => segments[i] === s);
  if (underHome && segments.length <= homeSegments.length + 1) return `${path} is home or a top folder in it`;
  if (segments[0] === "mnt" && segments.length <= 3) return `${path} is a drive or a top folder on it`;
  if (holdsKeptFiles(path)) return `${path} holds files git keeps (tracked, or untracked and not ignored)`;
  return null;
}

/**
 * WHAT: Formats the message a pane's owner or Mattias gets about a stuck prompt.
 * WHY: Keeps the reader from having to open tmux to see what is being asked.
 */
export function formatPermissionAlert({ paneKey, ageMs, reason, command, why }) {
  const cmd = String(command || "").split("\n").slice(0, 8).join("\n");
  return [
    `Panel ${paneKey} har stått ${Math.round(ageMs / 60_000)} min på en Ja/Nej-fråga som amux inte svarar på själv (${why}).`,
    reason ? `Skäl: ${reason}` : "",
    cmd ? `Kommando:\n${cmd}` : "",
    `Svara i panelen: amux ${paneKey.replace(":", " -p ")} -- 1   (eller 2 för nej)`,
  ].filter(Boolean).join("\n");
}
