// amux revive — selective post-boot fleet recovery (T13).
//
// The 2026-07-20 incident proved the old contract wrong twice: a whole-fleet
// respawn launched ~70 panes at once into a low-memory host, and the
// interrupted set was classified "none" because Kimi panes emit no ledger
// hook events. Now: the interrupted set is derived from every engine's own
// journal (ledger + Codex rollout + Kimi Wire), and only that set is
// revived by default. The remaining panes start on demand; --all restores
// the legacy whole-fleet respawn.

import { readFileSync } from "fs";
import { join } from "path";
import { listAgents } from "./config.mjs";
import { getPaneStatus, sendToPane } from "./tmux.mjs";
import { startNativeServices } from "./native-service-manager.mjs";
import { appendEvent, readEvents } from "../core/events.mjs";
import {
  journalInterruptionFromTurns, planRevive, reviveBrief, parseBootMs, selectRevivePanes,
} from "../core/revive.mjs";
import { readLastTurnsCodex } from "../core/codex-jsonl-reader.mjs";
import { readLastTurnsKimi } from "../core/kimi-jsonl-reader.mjs";

const ENGINE_READERS = [
  { pattern: /codex/, source: "codex-jsonl", read: readLastTurnsCodex },
  { pattern: /kimi(?:-code)?/, source: "kimi-jsonl", read: readLastTurnsKimi },
];

/** WHAT: Reads one pane's pre-boot interruption from its engine journal. WHY: Keeps Kimi/Codex evidence beside the ledger's Claude events. */
function readPaneInterruption(pane, agent, bootMs) {
  for (const engine of ENGINE_READERS) {
    if (!engine.pattern.test(String(pane.cmd || ""))) continue;
    try {
      const paneDir = join(agent.dir, ".agents", String(pane.pane));
      const result = engine.read(paneDir, { limit: 4, tailBytes: 16 * 1024 * 1024, headless: true });
      const interruptedAtMs = journalInterruptionFromTurns(result?.turns || [], bootMs);
      if (interruptedAtMs) {
        return { agent: pane.agent, pane: pane.pane, interruptedAtMs, source: engine.source };
      }
    } catch { /* missing/partial journal: classification continues without it */ }
    return null;
  }
  return null;
}

/** WHAT: Maps journals and statuses to a selective revive plan and executes it. WHY: Prevents whole-fleet storms and silent classification misses. */
export async function cmdRevive(ctx, flags, { configuredServiceTargets }) {
  const bootMs = parseBootMs(readFileSync("/proc/stat", "utf-8"));
  if (!bootMs) { console.error("Kunde inte läsa boot-tid ur /proc/stat."); process.exit(1); }
  console.log(`Boot: ${new Date(bootMs).toLocaleString("sv-SE")}`);

  const agents = listAgents(ctx.configPath);
  const nativeServiceTargets = configuredServiceTargets(ctx)
    .filter((target) => target.backend === "native");
  const panes = [];
  for (const a of agents) {
    (a.panes || []).forEach((p, i) => {
      if (/claude|codex|kimi(?:-code)?/.test(String(p?.cmd || ""))) {
        panes.push({ agent: a.name, pane: i, cmd: p.cmd, backend: a.backend });
      }
    });
  }

  const statuses = new Map();
  const journalInterruptions = [];
  for (const p of panes) {
    try { statuses.set(`${p.agent}:${p.pane}`, await getPaneStatus(ctx, p.agent, p.pane)); }
    catch { statuses.set(`${p.agent}:${p.pane}`, "unknown"); }
    if (p.backend === "native") continue;
    const agent = agents.find((item) => item.name === p.agent);
    const interruption = agent ? readPaneInterruption(p, agent, bootMs) : null;
    if (interruption) journalInterruptions.push(interruption);
  }

  let events = [];
  try { events = readEvents({ tailBytes: 0 }); } catch { /* empty ledger: classification still runs */ }
  const plan = planRevive({ events, bootMs, panes, statuses, journalInterruptions });
  const reviveSet = selectRevivePanes(panes, plan.briefs, { all: Boolean(flags.all) });

  console.log(`Klassificering: ${plan.briefs.length} avbrutna av ${panes.length} konfigurerade coding-panes.`);
  for (const b of plan.briefs) {
    console.log(`  ⚡ ${b.agent}:${b.pane}  avbruten ${new Date(b.interruptedAtMs).toTimeString().slice(0, 8)} (${b.source || "ledger"})`);
  }
  if (!plan.briefs.length) console.log("Avbrutna mitt i arbete: inga.");
  console.log(flags.all
    ? `Återställer ALLA ${reviveSet.length} panes (--all).`
    : `Selektiv revive: ${reviveSet.length} panes med bevisat avbrott återställs; övriga startas on demand (--all för legacy).`);
  console.log(`Tjänster: ${nativeServiceTargets.reduce((sum, target) => sum + target.services.length, 0)} native-processer säkras (idempotent).`);
  if (flags.dry) return;

  for (const p of reviveSet) {
    try {
      if (p.backend === "native") await ctx.agent.nativeRuntime.ensureTarget(p.agent, p.pane);
      else await ctx.agent.ensureReady(p.agent, p.pane);
    }
    catch (err) { console.error(`  ensureReady ${p.agent}:${p.pane} misslyckades: ${err.message.split("\n")[0]}`); }
  }
  for (const target of nativeServiceTargets) {
    try { await startNativeServices(target); }
    catch (err) { console.error(`  services ${target.name} misslyckades: ${err.message.split("\n")[0]}`); }
  }
  for (const b of plan.briefs) {
    const sent = await sendToPane(ctx, b.agent, b.pane, reviveBrief(b.interruptedAtMs, bootMs));
    if (!sent?.delivered) {
      console.error(`  INTE skickad: ${b.agent}:${b.pane} (${sent?.blocked ? "parkerad" : "leverans ej verifierad"})`);
      continue;
    }
    try {
      appendEvent({
        ts: new Date().toISOString(),
        event: "revive_brief",
        session: b.agent,
        pane: b.pane,
        interruptedAtMs: b.interruptedAtMs,
        detail: `boot ${new Date(bootMs).toISOString()}`,
      });
    } catch (err) {
      console.error(`  revive receipt ${b.agent}:${b.pane} misslyckades: ${err.message}`);
    }
    console.log(`  skickad: ${b.agent}:${b.pane}`);
  }
  console.log("Revive klar.");
}
