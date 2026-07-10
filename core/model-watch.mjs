// Model-watch: detect when a pane's model silently changes mid-session.
//
// Two real producers (2026-07-10): codex quota exhaustion dropped ai:3 from
// gpt-5.6 to gpt-5.5 mid-critical-work ("You've hit your usage limit"), and
// Claude falls back fable→opus under context pressure. Both times the human
// noticed by accident and had to hand-hold ("vi behövde tillfälligt byta
// till en mindre smart modell.. tänk igenom planen en gång till").
//
// Policy (Mattias's calls, 2026-07-10): a MODEL downgrade stops the pane —
// work built on a weaker model creates bugs that cost more to find later
// ("man behöver fixa buggarna sen"). An EFFORT-only drop within the same
// model ("max→xhigh är nästan okej") warns without stopping: the quality
// delta is one notch, and crash-respawns routinely restore an older effort
// setting, so stop-on-effort would add friction exactly when the fleet is
// recovering. Every change still gets a channel line + ledger row.

const EFFORT_TIERS = { max: 5, xhigh: 4, high: 3, medium: 2, low: 1, minimal: 0 };
const CLAUDE_FAMILY = { fable: 5, mythos: 5, opus: 4, sonnet: 3, haiku: 2 };
const CODEX_VARIANT = { sol: 3, luna: 2, mini: 1 };

/**
 * Comparable rank within a model family, or null for unknown strings.
 * Families never compare against each other (a pane keeps its harness);
 * callers treat cross-family or unknown as "lateral".
 */
export function modelRank(model) {
  const m = String(model || "").toLowerCase();
  if (!m) return null;

  const claude = Object.keys(CLAUDE_FAMILY).find((f) => m.includes(f));
  if (claude) {
    const version = m.match(/(\d+(?:\.\d+)?)/);
    return { family: "claude", score: CLAUDE_FAMILY[claude] * 100 + (version ? parseFloat(version[1]) : 0) };
  }

  const gpt = m.match(/gpt-(\d+(?:\.\d+)?)/);
  if (gpt) {
    const variant = Object.keys(CODEX_VARIANT).find((v) => m.includes(v));
    return { family: "gpt", score: parseFloat(gpt[1]) * 10 + (variant ? CODEX_VARIANT[variant] : 2) };
  }

  return null;
}

/**
 * Compare two {model, effort} sightings from the same pane.
 * Returns null when nothing changed, else
 * { direction: "downgrade" | "upgrade" | "lateral", from, to }.
 */
export function classifyModelChange(prev, next) {
  const fromLabel = label(prev);
  const toLabel = label(next);
  if (!fromLabel || !toLabel || fromLabel === toLabel) return null;

  const change = { direction: "lateral", kind: "model", from: fromLabel, to: toLabel };
  const a = modelRank(prev.model);
  const b = modelRank(next.model);

  if (a && b && a.family === b.family && a.score !== b.score) {
    change.direction = b.score < a.score ? "downgrade" : "upgrade";
    return change;
  }
  // Same model — the effort knob moved. Lesser severity by policy.
  if (prev.model === next.model && prev.effort !== next.effort) {
    change.kind = "effort";
    const ea = EFFORT_TIERS[String(prev.effort || "").toLowerCase()];
    const eb = EFFORT_TIERS[String(next.effort || "").toLowerCase()];
    if (Number.isFinite(ea) && Number.isFinite(eb) && ea !== eb) {
      change.direction = eb < ea ? "downgrade" : "upgrade";
    }
  }
  return change;
}

/** Only model-kind downgrades park the pane; effort drops just warn. */
export function shouldStopPane(change) {
  return change?.direction === "downgrade" && change?.kind === "model";
}

export function label({ model, effort } = {}) {
  if (!model) return null;
  return effort ? `${model} ${effort}` : String(model);
}

/** The channel warning. Short: the channel already shows the pane's work. */
export function changeMessage(paneName, change, contextPct) {
  const icon = { downgrade: "⚠️🔀", upgrade: "🔀⬆", lateral: "🔀" }[change.direction];
  const ctx = Number.isFinite(contextPct) ? ` (context ${contextPct}%)` : "";
  const stopped = change.direction === "downgrade" && change.kind === "model";
  const effortDrop = change.direction === "downgrade" && change.kind === "effort";
  return `${icon} **${paneName} bytte modell: ${change.from} → ${change.to}**${ctx}` +
    (stopped
      ? "\n_Panelen är STOPPAD (kvot/limit eller context-fallback). Knuffa igång den när läget är rätt — /model byter tillbaka. Den re-verifierar sina senaste beslut vid återstart._"
      : effortDrop
        ? "\n_Effort sänkt (trolig orsak: respawn återställde sparad inställning). Panelen jobbar vidare — sätt tillbaka med /model när du vill._"
        : "");
}

/**
 * Parks the pane. Processed by the downgraded model, so it is deliberately
 * trivial: stop now, and carry the re-verify instruction for the resume.
 */
export function stopBrief(change) {
  return `[model-watch] Du är nedgraderad ${change.from} → ${change.to} (kvot/limit eller context-fallback). ` +
    "STANNA NU: parkera arbetet, committa inget, svara endast med en kort statusrad om exakt var du står. " +
    "När användaren återupptar dig: börja med att re-verifiera beslut och kod från precis före bytet — lita inte på dem overifierade.";
}

// --- Auto-recovery (one loop-guarded switch-back attempt per incident) ---
//
// The flap scenario makes unbounded retries dangerous: during quota
// exhaustion a switch-back "succeeds" in the UI and bounces down again on
// the next request, which would trigger recovery again, forever. The guard
// is structural: the attempt is recorded BEFORE acting, and a downgrade
// arriving inside the cooldown window (= a flap, or a crash-respawned
// bridge) never attempts at all. Worst case is exactly the old behavior
// plus one harmless extra /model command.

export const RECOVERY_COOLDOWN_MS = 30 * 60_000;

export function decideRecovery({ lastAttemptMs = null, nowMs = Date.now(), enabled = true, cooldownMs = RECOVERY_COOLDOWN_MS } = {}) {
  if (!enabled) return { attempt: false, reason: "disabled (AMUX_MODEL_RECOVERY=false)" };
  if (Number.isFinite(lastAttemptMs) && nowMs - lastAttemptMs < cooldownMs) {
    return { attempt: false, reason: "inside cooldown (flap or recent attempt)" };
  }
  return { attempt: true, reason: "first attempt this incident" };
}

/** Wakes a successfully recovered pane; carries the re-verify duty. */
export function resumeBrief(restoredLabel) {
  return `[model-watch] Modell återställd till ${restoredLabel}. ` +
    "Re-verifiera beslut och kod från nedgraderingsfönstret innan du bygger vidare, fortsätt sedan din uppgift.";
}

/** Channel line for the recovery outcome. */
export function recoveryMessage(paneName, restored, detail) {
  return restored
    ? `🔁 **${paneName}: auto-recovery lyckades** — ${detail}. Panelen väckt med re-verify-brief.`
    : `🅿 **${paneName}: auto-recovery misslyckades** (${detail}). Panelen kvar parkerad — \`/model\` när läget är rätt.`;
}
