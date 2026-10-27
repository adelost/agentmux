const HOUR = 3600000;
const TERMINAL = /^(?:done|closed|cancelled|canceled|dropped|retired|incorporated|superseded|replaced|stängd|klar[ta]?|färdig|levererad)(?:\b|(?=\d))/iu;
const WORKING = /^(?:working|active|doing|in.progress|pågår|arbetar)\b/iu;
const BLOCKED = /^(?:blocked|blockerad|waiting|väntar|stopp?|hold|paused)\b/iu;

/** WHAT: Returns actual named row owners. WHY: Prevents staffing annotations from waking an unallocated builder. */
export function stateAgeOwners(cell) {
  if (/(?:unassigned|staffs|bemannar|utan ägare|no owner|not allocated)/iu.test(cell)) return [];
  return [...new Set(String(cell).match(/(?<![\p{L}\d_-])[a-z][\w-]*:\d+(?![\p{L}\d_:])/giu) || [])];
}

/** WHAT: Checks whether a ledger row remains open. WHY: Keeps historical completion text from suppressing an active row. */
export const stateAgeOpen = row => !TERMINAL.test(String(row.state || "").trim());

/** WHAT: Resolves the approved state-age threshold. WHY: Keeps blocked work on24h even when its priority is P2. */
export function stateAgeLimit(row) {
  return (BLOCKED.test(row.state || "") ? 24 : row.priority === "P0" ? 2 : row.priority === "P2" ? 72 : 24) * HOUR;
}

/** WHAT: Builds row and registration alarms from current ledger and pane evidence. WHY: Keeps TASKS as the task state and leaves unknown clocks unasserted. */
export function planStateAge({ projects, registrationProjects = projects, panes = [], now, seen = new Set() }) {
  if (!Number.isFinite(now)) throw Error("state-age requires an observation time");
  const day = new Date(now).toISOString().slice(0, 10), alarms = [], unknownClocks = [];
  const registered = new Set(registrationProjects.flatMap(p => p.rows.filter(r => stateAgeOpen(r) && WORKING.test(r.state || ""))
    .flatMap(r => stateAgeOwners(r.owner))));
  for (const project of projects) {
    if (!/^[\w-]+:\d+$/u.test(project.dispatcher)) throw Error(`Missing named dispatcher for ${project.id}`);
    const open = project.rows.filter(stateAgeOpen);
    const ambiguous = new Set(open.filter(row => open.filter(other => other.row === row.row).length > 1).map(row => row.row));
    for (const id of ambiguous) unknownClocks.push({ project: project.id, row: id, kind: "duplicate-row", lines: open.filter(row => row.row === id).map(row => row.line) });
    for (const row of open.filter(row => !ambiguous.has(row.row))) {
      const owners = stateAgeOwners(row.owner), reasons = [], idleOwners = [], limitMs = stateAgeLimit(row);
      const ageMs = Number.isFinite(row.changedAt) && row.changedAt <= now ? now - row.changedAt : null;
      if (ageMs === null) unknownClocks.push({ project: project.id, row: row.row, kind: "row" });
      else if (ageMs >= limitMs) reasons.push("state-age");
      if (WORKING.test(row.state || "")) for (const owner of owners) {
        const pane = panes.find(p => p.key === owner);
        if (!pane || !["idle", "stopped"].includes(pane.status) || !Number.isFinite(pane.idleSince) || pane.idleSince > now) {
          if (!pane || ["idle", "stopped"].includes(pane.status)) unknownClocks.push({ project: project.id, row: row.row, pane: owner, kind: "idle" });
        } else if (now - pane.idleSince >= 2 * HOUR) {
          reasons.push(`owner-idle:${owner}`); idleOwners.push({ pane: owner, ageMs: now - pane.idleSince, limitMs: 2 * HOUR });
        }
      }
      const key = `${day}:${project.id}:row:${row.row}`;
      if (reasons.length && !seen.has(key)) alarms.push({ key, kind: "row", project: project.id, row: row.row,
        title: row.title, state: row.state, ageMs, limitMs, reasons, idleOwners, noOwner: !owners.length,
        recipients: [...new Set([...owners, project.dispatcher])] });
    }
    for (const pane of panes.filter(p => p.status === "working" && project.panes?.includes(p.key) && !registered.has(p.key))) {
      if (!Number.isFinite(pane.workingSince) || pane.workingSince > now) {
        unknownClocks.push({ project: project.id, pane: pane.key, kind: "working" }); continue;
      }
      const key = `${day}:${project.id}:pane:${pane.key}`;
      if (now - pane.workingSince >= HOUR && !seen.has(key)) alarms.push({ key, kind: "unregistered", project: project.id,
        pane: pane.key, state: "working outside a row", ageMs: now - pane.workingSince, limitMs: HOUR,
        reasons: ["working-outside-row"], recipients: [project.dispatcher] });
    }
  }
  return { day, alarms, unknownClocks, messages: alarms.flatMap(alarm => alarm.recipients.map(target => ({
    alarmKey: alarm.key, target, idempotencyKey: `state-age:${alarm.key}:${target}`, alarm,
  }))) };
}

/** WHAT: Builds daily recipient reservations before queue effects. WHY: Prevents crashes or repeated ticks from exceeding the9-message daily ceiling. */
export function reserveStateAgeMessages(plan, previous = {}) {
  const reservations = Object.fromEntries(Object.entries(previous).filter(([, day]) => day >= plan.day));
  for (const message of plan.messages) reservations[message.idempotencyKey] = plan.day;
  if (Object.values(reservations).filter(day => day === plan.day).length >= 10) throw Error("State-age activation refused: daily recipient messages would reach10");
  return reservations;
}

/** WHAT: Formats one actionable age alarm. WHY: Keeps owners and dispatchers on the same state-change choices. */
export function stateAgeMessage(alarm) {
  const age = alarm.ageMs === null ? "okänd" : (alarm.ageMs / HOUR).toFixed(1), limit = alarm.limitMs / HOUR;
  const subject = alarm.kind === "row" ? `${alarm.row} (${String(alarm.title || "uppgift utan namn").split(/\s+/u).slice(0, 4).join(" ")})` : alarm.pane;
  const idle = (alarm.idleOwners || []).map(owner => `${owner.pane} idle/stopped ${(owner.ageMs / HOUR).toFixed(1)} h, gräns2h`).join("; ");
  return `[state-age] ${subject}: ${alarm.state}. Ålder ${age} h; gräns ${limit} h. ${alarm.noOwner ? "Raden saknar tilldelad ägare. " : ""}${idle || alarm.reasons.join(", ")}. Ändra läget, ange ett konkret hinder med datum, eller stryk med skäl.`;
}
