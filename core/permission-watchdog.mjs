// Recognition and policy for Claude Code permission prompts that block a pane.
// Pure functions; the channel in channels/permission-watchdog.mjs does the I/O.
//
// Origin (2026-09-12): a paid Modal training run sat 21 minutes behind
// "Dangerous rm operation on possibly-empty variable path" because bypass
// mode still asks for that one, the pane cannot answer itself and nothing in
// amux read the screen. Mattias: "får inte hända igen".

export const DEFAULT_PERMISSION_WATCHDOG_CONFIG = {
  enabled: true,
  autoAnswer: true,
  pollMs: 30_000,
  promptAgeMs: 120_000,
};

export function parsePermissionWatchdogConfig(env = process.env) {
  const int = (v, d) => { const n = parseInt(v ?? "", 10); return Number.isFinite(n) && n > 0 ? n : d; };
  return {
    enabled: env.AMUX_PERMISSION_WATCHDOG_ENABLED !== "false",
    autoAnswer: env.AMUX_PERMISSION_WATCHDOG_AUTO_ANSWER !== "false",
    pollMs: int(env.AMUX_PERMISSION_WATCHDOG_POLL_MS, DEFAULT_PERMISSION_WATCHDOG_CONFIG.pollMs),
    promptAgeMs: int(env.AMUX_PERMISSION_WATCHDOG_PROMPT_AGE_MS, DEFAULT_PERMISSION_WATCHDOG_CONFIG.promptAgeMs),
  };
}

const strip = (s) => String(s || "").replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, "");

/**
 * WHAT: Finds an ACTIVE Claude Code permission prompt at the bottom of a pane.
 * WHY: The same text lingers in scrollback after it was answered; only a prompt
 * with "Do you want to proceed?" and its numbered options in the last lines,
 * and no composer prompt below them, is something anyone should act on.
 * Returns null or { signature, reason, command, options }.
 */
export function detectPermissionPrompt(paneText) {
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

  const askIdx = lines.findIndex((l, i) => i <= lastOptionIdx && /Do you want to proceed\?/u.test(l));
  // Command box: lines starting with "│" above the question; the box may carry
  // a trailing description line ("Relaunch the v8 training ...").
  const command = lines.slice(0, askIdx).filter((l) => /^\s*│/u.test(l)).map((l) => l.replace(/^\s*│\s?/u, "")).join("\n").trim();
  // Reason: the last non-empty, non-box, non-title line before the question.
  const reason = lines.slice(0, askIdx).map((l) => l.trim()).filter((l) => l && !/^│/u.test(l) && !/^Bash command$/u.test(l) && !/^[─┌┐└┘]+$/u.test(l)).at(-1) || "";
  const signature = `${reason}\n${command}`.slice(0, 600);
  return { signature, reason, command, options };
}

/**
 * WHAT: Decides whether a prompt may be answered "yes" without a human.
 * WHY: Exactly one pattern is known to be a false alarm: rm on "$VAR"/... where
 * the same block sets VAR to a literal absolute path deep enough that nothing
 * important sits at that level. Everything else is a human decision.
 * Returns { action: "answer", keys } or { action: "notify", why }.
 */
export function classifyPermissionPrompt({ reason = "", command = "" } = {}) {
  const m = /possibly-empty variable path:\s*(.+)$/u.exec(reason);
  if (!m) return { action: "notify", why: "not the variable-path rm check" };
  const targets = m[1].trim().split(/\s+/u);
  const vars = new Set();
  for (const t of targets) {
    const v = /^"?\$\{?([A-Za-z_][A-Za-z0-9_]*)\}?"?\/\S+$/u.exec(t);
    if (!v) return { action: "notify", why: `rm target is not "$VAR"/something: ${t}` };
    vars.add(v[1]);
  }
  for (const v of vars) {
    const assign = new RegExp(`(?:^|[;\\n]|&&|\\|\\|)\\s*${v}=("?)(\\/[^\\s"';&|]+)\\1(?=\\s|;|$)`, "u").exec(command);
    if (!assign) return { action: "notify", why: `${v} is not assigned to a literal absolute path in the same command` };
    const path = assign[2];
    if (/\$/u.test(path)) return { action: "notify", why: `${v} is assigned from another variable` };
    if (path.split("/").filter(Boolean).length < 3) return { action: "notify", why: `${v}=${path} is too close to the filesystem root` };
  }
  return { action: "answer", keys: "1", why: `rm targets stay under a literal path set in the same command (${[...vars].join(", ")})` };
}

export function formatPermissionAlert({ paneKey, ageMs, reason, command, why }) {
  const cmd = String(command || "").split("\n").slice(0, 8).join("\n");
  return [
    `Panel ${paneKey} har stått ${Math.round(ageMs / 60_000)} min på en Ja/Nej-fråga som amux inte svarar på själv (${why}).`,
    reason ? `Skäl: ${reason}` : "",
    cmd ? `Kommando:\n${cmd}` : "",
    `Svara i panelen: amux ${paneKey.replace(":", " -p ")} -- 1   (eller 2 för nej)`,
  ].filter(Boolean).join("\n");
}
