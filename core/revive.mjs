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
// interrupted turn is derived from the latest structured rollout instead.
// Reopening the session alone can leave Codex waiting at an interrupted
// composer forever after a hard WSL stop.

/** WHAT: Returns the timestamp of a journal turn interrupted by boot, or null. WHY: Keeps interruption evidence in the engine's own durable journal. */
export function journalInterruptionFromTurns(turns = [], bootMs) {
  if (!Number.isFinite(bootMs)) return null;
  let latestPreBoot = null;
  for (const turn of turns) {
    const ms = Date.parse(turn?.timestamp || "");
    if (!Number.isFinite(ms)) continue;
    if (ms >= bootMs) return null;
    if (!latestPreBoot || ms >= latestPreBoot.ms) latestPreBoot = { turn, ms };
  }
  if (!latestPreBoot || latestPreBoot.turn?.isComplete !== false) return null;
  return latestPreBoot.ms;
}

/** WHAT: Returns the timestamp of a Codex turn interrupted by boot, or null. WHY: Keeps Codex recovery evidence in its own rollout. */
export function codexInterruptionFromTurns(turns = [], bootMs) {
  return journalInterruptionFromTurns(turns, bootMs);
}

/** Boot instant from /proc/stat's btime line (seconds → ms). */
export function parseBootMs(procStat) {
  const m = String(procStat).match(/^btime (\d+)$/m);
  return m ? Number(m[1]) * 1000 : null;
}

/** WHAT: Maps ledger, statuses, and journals to the panes needing a resume-brief. WHY: Keeps recovery evidence-based, never age- or screen-based. */
export function planRevive({
  events = [],
  bootMs,
  panes = [],
  statuses = new Map(),
  journalInterruptions = [],
}) {
  if (!Number.isFinite(bootMs)) return { briefs: [], reason: "no boot time" };

  // Last prompt/stop per pane BEFORE boot: a trailing prompt = interrupted.
  const last = new Map();
  const revived = new Map();
  const activeAfterBoot = new Set();
  for (const e of events) {
    const ms = Date.parse(e.ts);
    if (!Number.isFinite(ms)) continue;
    const key = `${e.session}:${e.pane}`;
    if (e?.event === "revive_brief" && ms >= bootMs) {
      const interruptedAtMs = Number(e.interruptedAtMs);
      if (Number.isFinite(interruptedAtMs)) {
        revived.set(key, Math.max(revived.get(key) || 0, interruptedAtMs));
      }
      continue;
    }
    if ((e?.event === "prompt" || e?.event === "stop") && ms >= bootMs) {
      // The pane has already accepted or completed a post-boot turn. Injecting
      // stale crash archaeology hours later interrupts current work and can
      // reopen tasks the user already resolved manually.
      activeAfterBoot.add(key);
      continue;
    }
    if ((e?.event !== "prompt" && e?.event !== "stop") || ms >= bootMs) continue;
    const current = last.get(key);
    if (!current || ms >= current.ms) last.set(key, { ev: e.event, ms });
  }

  const briefs = [];
  for (const p of panes) {
    const key = `${p.agent}:${p.pane}`;
    const pre = last.get(key);
    if (!pre || pre.ev !== "prompt") continue; // finished cleanly or untouched
    if (activeAfterBoot.has(key)) continue; // already resumed or received newer work
    if ((revived.get(key) || 0) >= pre.ms) continue; // already briefed for this interruption
    const status = statuses.get(key);
    if (status === "working" || status === "resume") continue; // already back at it
    briefs.push({ agent: p.agent, pane: p.pane, interruptedAtMs: pre.ms });
  }
  for (const interruption of journalInterruptions) {
    const key = `${interruption.agent}:${interruption.pane}`;
    if (briefs.some((brief) => `${brief.agent}:${brief.pane}` === key)) continue;
    if ((revived.get(key) || 0) >= interruption.interruptedAtMs) continue;
    const status = statuses.get(key);
    if (status === "working" || status === "resume") continue;
    briefs.push({ ...interruption });
  }
  return { briefs };
}

/** WHAT: Filters which panes to revive. WHY: Keeps selective recovery the default, never the storm. */
export function selectRevivePanes(panes, briefs, { all = false } = {}) {
  if (all) return panes;
  const keys = new Set(briefs.map((b) => `${b.agent}:${b.pane}`));
  return panes.filter((p) => keys.has(`${p.agent}:${p.pane}`));
}

export function reviveBrief(interruptedAtMs, bootMs) {
  const hhmm = (ms) => new Date(ms).toTimeString().slice(0, 5);
  return `[krasch-recovery] Värden startade om ${hhmm(bootMs)} mitt i din pågående turn ` +
    `(din prompt ${hhmm(interruptedAtMs)} fick aldrig avslut). ` +
    "Återanchra dig via amux done + din jsonl-historik, identifiera vad som blev hängande och återuppta det. " +
    "Om inget faktiskt hängde: en rad status, sen standby.";
}
