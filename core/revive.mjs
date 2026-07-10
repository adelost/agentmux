// amux revive — post-boot fleet recovery.
//
// A host crash/reboot leaves three kinds of damage (observed 2026-07-10
// 18:58, WSL): dead sessions nobody recreates (skybar vanished entirely),
// panes that respawn fine on their own, and panes that were MID-TURN when
// the world ended — their prompt never got a stop, and nothing tells them
// to pick the work back up. The human had to do ledger archaeology by hand.
//
// planRevive automates exactly that archaeology: the event ledger's
// prompt-without-stop before boot IS the interrupted set (validated against
// the real 2026-07-10 crash: it yields ai:0, ai:2, api:1 — the three panes
// found by hand). Panes already working again are left alone (ai:2
// self-recovered via --continue). Codex panes emit no hook events, so their
// interruptions are invisible here — they auto-resume via `codex resume
// --last` at respawn, which is the best available behavior anyway.

/** Boot instant from /proc/stat's btime line (seconds → ms). */
export function parseBootMs(procStat) {
  const m = String(procStat).match(/^btime (\d+)$/m);
  return m ? Number(m[1]) * 1000 : null;
}

/**
 * Decide which panes need a resume-brief.
 * events: ledger rows ({ts, event, session, pane}); panes: configured coding
 * panes [{agent, pane}]; statuses: Map "agent:pane" → current status.
 */
export function planRevive({ events = [], bootMs, panes = [], statuses = new Map() }) {
  if (!Number.isFinite(bootMs)) return { briefs: [], reason: "no boot time" };

  // Last prompt/stop per pane BEFORE boot: a trailing prompt = interrupted.
  const last = new Map();
  for (const e of events) {
    if (e?.event !== "prompt" && e?.event !== "stop") continue;
    const ms = Date.parse(e.ts);
    if (!Number.isFinite(ms) || ms >= bootMs) continue;
    last.set(`${e.session}:${e.pane}`, { ev: e.event, ms });
  }

  const briefs = [];
  for (const p of panes) {
    const key = `${p.agent}:${p.pane}`;
    const pre = last.get(key);
    if (!pre || pre.ev !== "prompt") continue; // finished cleanly or untouched
    const status = statuses.get(key);
    if (status === "working" || status === "resume") continue; // already back at it
    briefs.push({ agent: p.agent, pane: p.pane, interruptedAtMs: pre.ms });
  }
  return { briefs };
}

export function reviveBrief(interruptedAtMs, bootMs) {
  const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);
  return `[krasch-recovery] Värden startade om ${hhmm(bootMs)} mitt i din pågående turn ` +
    `(din prompt ${hhmm(interruptedAtMs)} fick aldrig avslut). ` +
    "Återanchra dig via amux done + din jsonl-historik, identifiera vad som blev hängande och återuppta det. " +
    "Om inget faktiskt hängde: en rad status, sen standby.";
}
