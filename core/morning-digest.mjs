// WHAT: The pure compositor for the 08:00 morning digest — ONE DM that
//       collects everything waiting on the HUMAN: remindable todos, board
//       tickets in needs_detail (creator questions) and open human-directed
//       asks from panes.
// WHY: Agents have watchdogs; the human had none. Decisions rotted in
//      deferred-comment prose and scroll-back (SRC-0011 sat 25h; the
//      night-parking pile), so the human's queue must arrive as one
//      bounded push instead of being spread across surfaces.
// DOES NOT: Fetch anything, know about cron, or send. The CLI command
//           gathers inputs; this module only shapes the message.

const ITEM_CAP = 5;

const capped = (lines, cap = ITEM_CAP) => {
  if (lines.length <= cap) return lines;
  return [...lines.slice(0, cap), `  … +${lines.length - cap} till`];
};

const formatAge = (ageMs) => {
  const hours = Math.floor(ageMs / 3_600_000);
  if (hours >= 24) return `${Math.floor(hours / 24)}d`;
  if (hours >= 1) return `${hours}h`;
  return `${Math.max(1, Math.floor(ageMs / 60_000))}min`;
};

/**
 * Compose the digest, or null when there is nothing waiting on the human
 * (a silent day sends nothing — signal survives only if quiet is honest).
 *
 * boardDecisions: [{ project, id, title }]
 * openAsks: [{ key, promptPreview, ageMs }] — pre-filtered to open,
 *   human-directed asks (the SRC-0053 classifiers own that judgment).
 * boardFailures: [projectName] — boards that could not be read; surfaced
 *   loudly so an auth-flip never reads as an empty queue.
 */
export function composeMorningDigest({ todoSummary = null, boardDecisions = [],
  openAsks = [], boardFailures = [] } = {}) {
  const sections = [];
  if (todoSummary) sections.push(`📋 Todos: ${todoSummary}`);
  if (boardDecisions.length) {
    sections.push([`🎫 Väntar på ditt svar på boarden (${boardDecisions.length}):`,
      ...capped(boardDecisions.map((item) =>
        `  ${item.id} [${item.project}] ${item.title}`))].join("\n"));
  }
  if (openAsks.length) {
    sections.push([`🙋 Öppna frågor från panes (${openAsks.length}):`,
      ...capped(openAsks.map((ask) =>
        `  ${ask.key} (${formatAge(ask.ageMs)}): ${ask.promptPreview}`))].join("\n"));
  }
  if (boardFailures.length) {
    sections.push(`⚠️ Kunde inte läsa board: ${boardFailures.join(", ")} — tom kö är INTE verifierad.`);
  }
  if (!sections.length) return null;
  return `God morgon! Din kö:\n${sections.join("\n")}`;
}

/** Parse fleets.conf lines into [{session, project}] for board reads. */
export function digestProjects(confText) {
  const projects = [];
  for (const line of String(confText || "").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const [session, , , project] = trimmed.split(/\s+/u);
    if (session && project && !projects.some((item) => item.project === project)) {
      projects.push({ session, project });
    }
  }
  return projects;
}

/** Shape a board ticket row into a digest decision line input. */
export function boardDecisionItem(project, ticket) {
  const title = String(ticket.title || ticket.raw || "").replace(/\s+/gu, " ").slice(0, 70);
  return { project, id: String(ticket.id), title };
}
