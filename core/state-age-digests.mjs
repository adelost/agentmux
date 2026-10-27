import { stateAgeMessage } from "./state-age-guard.mjs";

const id = alarm => `${alarm.project}:${alarm.row || alarm.pane}`;
const oldest = (a, b) => (b.ageMs || 0) - (a.ageMs || 0) || id(a).localeCompare(id(b));

/** WHAT: Builds a dependency forest of overdue rows. WHY: Keeps a waiting child under its overdue parent instead of issuing a separate alarm. */
export function stateAgeGroups(alarms) {
  const byId = new Map(alarms.map(a => [id(a), a])), parent = new Map();
  for (const alarm of alarms) if (alarm.kind === "row") {
    for (const match of String(alarm.dependencyText || "").matchAll(/(?:after|until|waits on|blocked\s*:|efter|väntar på|blockerad av)\s*#?(\d+[a-z]*)/giu)) {
      const candidate = `${alarm.project}:${match[1]}`;
      if (candidate === id(alarm) || !byId.has(candidate)) continue;
      let cursor = candidate, cycle = false;
      const seen = new Set([id(alarm)]);
      while (cursor) { if (seen.has(cursor)) { cycle = true; break; } seen.add(cursor); cursor = parent.get(cursor); }
      if (!cycle) { parent.set(id(alarm), candidate); break; }
    }
  }
  const root = alarm => { let key = id(alarm); while (parent.has(key)) key = parent.get(key); return byId.get(key); };
  return { byId, parent, root };
}

/** WHAT: Builds one daily digest for each actual recipient. WHY: Prevents row volume from becoming repeated owner or dispatcher wakeups. */
export function stateAgeDigests(plan, projects, seen = new Set()) {
  const messages = [], targets = [...new Set(plan.alarms.flatMap(a => a.recipients))];
  const forest = stateAgeGroups(plan.alarms);
  for (const target of targets) {
    const key = `${plan.day}:recipient:${target}`, idempotencyKey = `state-age-v2:${key}`;
    if (seen.has(idempotencyKey)) continue;
    const lines = [`[state-age] ${plan.day}`], mentioned = new Map();
    const render = selected => {
      const included = new Map(), children = new Map();
      for (const alarm of selected.sort(oldest)) {
        let cursor = id(alarm);
        while (cursor) { included.set(cursor, forest.byId.get(cursor)); cursor = forest.parent.get(cursor); }
      }
      for (const [key, alarm] of included) {
        const parent = forest.parent.get(key);
        if (!children.has(parent)) children.set(parent, []);
        children.get(parent).push(alarm);
      }
      const print = (alarm, depth) => {
        lines.push(`${"  ".repeat(depth)}${depth ? "↳ " : ""}${stateAgeMessage(alarm).replace(/^\[state-age\]\s*/u, "")}`);
        mentioned.set(id(alarm), alarm);
        for (const child of (children.get(id(alarm)) || []).sort(oldest)) print(child, depth + 1);
      };
      for (const root of (children.get(undefined) || []).sort(oldest)) print(root, 0);
    };
    const dispatchProjects = projects.filter(p => p.dispatcher === target);
    for (const project of dispatchProjects) {
      const all = plan.alarms.filter(a => a.project === project.id), noOwner = all.filter(a => a.noOwner);
      lines.push(`${project.id}: utan ägare`); render(noOwner);
      const remaining = all.filter(a => !mentioned.has(id(a))).sort(oldest);
      lines.push(`${project.id}: tio äldsta`); render(remaining.slice(0, 10));
      lines.push(`${all.filter(a => a.kind === "row").length} rader över gränsen, ${noOwner.length} utan ägare, ${all.filter(a => a.kind === "unregistered").length} paneler utanför rad.`);
    }
    const own = plan.alarms.filter(a => a.recipients.includes(target) && !dispatchProjects.some(p => p.id === a.project)).sort(oldest);
    if (own.length) { lines.push("Dina rader, äldst först"); render(own.slice(0, 5)); if (own.length > 5) lines.push(`och ${own.length - 5} till`); }
    messages.push({ key, idempotencyKey, target, text: lines.join("\n"),
      mentioned: [...mentioned.values()].filter(a => a.kind === "row").map(a => ({ project: a.project, row: a.row })),
      alarmKeys: [...mentioned.values()].map(a => a.key) });
  }
  return messages;
}
