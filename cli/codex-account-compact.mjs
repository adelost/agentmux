import { join } from "node:path";
import { createContextMaintenance } from "../core/context-maintenance.mjs";
import { latestCodexSessionIdentity } from "../core/codex-jsonl-reader.mjs";
import { nightlyCompactDecision } from "../core/nightly-compact.mjs";
import { readContextCostPolicy } from "../policies/context-cost.mjs";
import { observeNightlyPane } from "./nightly-compact.mjs";

/** WHAT: Routes one guarded compact for an explicit Codex account switch.
 * WHY: Keeps switches on native generation proof instead of nightly session limits. */
export async function compactCodexBeforeSwitch(ctx, target, { dry = false } = {}) {
  if (target.engine !== "codex" || !target.sourceHome) throw new Error("Codex switch requires its verified source home");
  const name = target.agent.name, pane = target.pane.index;
  const facts = await observeNightlyPane(ctx, target, { queue: ctx.deliveryQueue });
  const reason = nightlyCompactDecision(facts, { enabled: true, maxTokens: readContextCostPolicy().maxTokens, idleMinutes: 0 }, null, { force: true });
  if (reason) return { ok: false, reason: `compact-skipped:${reason}` };
  const maintenance = createContextMaintenance({
    agent: ctx.agent, state: ctx.state, queue: ctx.deliveryQueue,
    resolveTarget: (n, p) => n === name && p === pane ? { engine: "codex", dir: target.paneDir } : null,
    identityFor: (_engine, dir) => latestCodexSessionIdentity(dir, { sessionDirs: [join(target.sourceHome, "sessions")], sessionId: target.sessionId }),
    log: message => console.error(`account compact | ${message}`),
  });
  return maintenance.run(name, pane, { required: true, dry });
}
