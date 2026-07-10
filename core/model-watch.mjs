// Model-watch: detect when a pane's model silently changes mid-session.
//
// Two real producers (2026-07-10): codex quota exhaustion dropped ai:3 from
// gpt-5.6 to gpt-5.5 mid-critical-work ("You've hit your usage limit"), and
// Claude falls back fable→opus under context pressure. Both times the human
// noticed by accident and had to hand-hold ("vi behövde tillfälligt byta
// till en mindre smart modell.. tänk igenom planen en gång till").
//
// Policy (Mattias's call, 2026-07-10): a downgraded pane STOPS. Work built
// on a weaker model creates bugs that cost more to find later than the
// stillstand costs now ("man behöver fixa buggarna sen"). So: every change
// gets a channel line + ledger row; a DOWNGRADE additionally interrupts the
// pane if it is mid-turn, parks it with a stop-brief (which carries the
// re-verify instruction for whenever the human resumes it), and pushes
// mobile so the stop is never silent.

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

  const change = { direction: "lateral", from: fromLabel, to: toLabel };
  const a = modelRank(prev.model);
  const b = modelRank(next.model);

  if (a && b && a.family === b.family && a.score !== b.score) {
    change.direction = b.score < a.score ? "downgrade" : "upgrade";
    return change;
  }
  // Same model — the effort knob moved.
  if (prev.model === next.model && prev.effort !== next.effort) {
    const ea = EFFORT_TIERS[String(prev.effort || "").toLowerCase()];
    const eb = EFFORT_TIERS[String(next.effort || "").toLowerCase()];
    if (Number.isFinite(ea) && Number.isFinite(eb) && ea !== eb) {
      change.direction = eb < ea ? "downgrade" : "upgrade";
    }
  }
  return change;
}

export function label({ model, effort } = {}) {
  if (!model) return null;
  return effort ? `${model} ${effort}` : String(model);
}

/** The channel warning. Short: the channel already shows the pane's work. */
export function changeMessage(paneName, change, contextPct) {
  const icon = { downgrade: "⚠️🔀", upgrade: "🔀⬆", lateral: "🔀" }[change.direction];
  const ctx = Number.isFinite(contextPct) ? ` (context ${contextPct}%)` : "";
  return `${icon} **${paneName} bytte modell: ${change.from} → ${change.to}**${ctx}` +
    (change.direction === "downgrade"
      ? "\n_Panelen är STOPPAD (kvot/limit eller context-fallback). Knuffa igång den när läget är rätt — /model byter tillbaka. Den re-verifierar sina senaste beslut vid återstart._"
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
