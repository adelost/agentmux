// The Dream curator's pane and its ordered fallbacks, read from the `dream:` section of agentmux.yaml.

import { nightlyCompactPolicy } from "./nightly-compact.mjs";
import { sourcePaneDialect, sourcePaneSlot } from "./source-pane-plan.mjs";

/** WHAT: Refuses a Dream pane that is not one configured tmux Claude or Codex pane. WHY: A typo fails `amux sync`, not the night's run. */
function validateDreamPane(agents, agent, pane, label) {
  const target = agents.get(agent);
  if (!agent || !Number.isSafeInteger(pane) || pane < 0 || !target || !sourcePaneSlot(target, pane)) {
    throw new Error(`agentmux.yaml: '${label}' must name one configured agent and pane`);
  }
  if (target.backend !== "tmux") {
    throw new Error(`agentmux.yaml: '${label}' target must be a tmux pane`);
  }
  const dialect = sourcePaneDialect(target, pane);
  if (dialect !== "claude" && dialect !== "codex") {
    throw new Error(`agentmux.yaml: '${label}' target must be a Claude or Codex pane`);
  }
}

/** WHAT: Reads one fallback curator written as `agent:pane` or `{ agent, pane }`. WHY: Both forms are in use. */
function candidateRef(ref) {
  if (typeof ref === "object" && ref !== null) return { agent: String(ref.agent || "").trim(), pane: Number(ref.pane) };
  const [agent, pane, ...rest] = String(ref ?? "").trim().split(":");
  return rest.length
    ? { agent: "", pane: Number.NaN }
    : { agent: String(agent || "").trim(), pane: pane === undefined ? Number.NaN : Number(pane) };
}

/**
 * WHAT: Parses the `dream:` section against the configured agents; null when the section is absent.
 * WHY: Keeps Dream on an operator-selected existing pane, never a hidden one-shot model process.
 */
export function parseDreamSection(section, agents) {
  if (section === undefined) return null;
  const agent = String(section?.agent || "").trim();
  const pane = Number(section?.pane);
  validateDreamPane(agents, agent, pane, "dream");
  const dream = { agent, pane };
  if (section.compact !== undefined) dream.compact = nightlyCompactPolicy(section.compact);

  // Optional ordered fallback curators. Validated here, at the same bar as the
  // primary, so a typo fails `amux sync` instead of quietly shrinking the list
  // at 04:00 and costing the night the list exists to protect.
  if (section.candidates !== undefined) {
    if (!Array.isArray(section.candidates)) {
      throw new Error("agentmux.yaml: 'dream.candidates' must be a list of agent:pane entries");
    }
    const candidates = [];
    for (const ref of section.candidates) {
      const parsed = candidateRef(ref);
      validateDreamPane(agents, parsed.agent, parsed.pane, `dream.candidates entry ${JSON.stringify(ref)}`);
      if (candidates.some((known) => known.agent === parsed.agent && known.pane === parsed.pane)) continue;
      candidates.push({ agent: parsed.agent, pane: parsed.pane });
    }
    if (candidates.length) dream.candidates = candidates.map((entry) => `${entry.agent}:${entry.pane}`);
  }
  return dream;
}
