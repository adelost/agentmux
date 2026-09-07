// Manual compact and the shared nightly maintenance entry.
import { listAgents } from "./config.mjs";
import { hasSession, listPanes, sendToPane } from "./tmux.mjs";
import { isCodingDialect } from "../core/dialects.mjs";
import { dialectFor, inspectPane } from "./inspect-pane.mjs";
import { isCompactUnsafe } from "../core/pane-status.mjs";
import { formatTokens } from "./format.mjs";
import { runNightlyCompact } from "./nightly-compact.mjs";

// Preserve the existing manual bulk threshold; nightly uses an absolute budget.
const COMPACT_MIN_TOKENS = 200_000;

/** WHAT: Routes manual and nightly compaction. WHY: Keeps explicit maintenance separate from daytime percentage policy. */
export async function cmdCompact(ctx, flags = {}, positional = []) {
  if (flags.help || flags.h) {
    console.log("Usage: amux compact [PERCENT | AGENT -p N] [--dry] [--min-tokens N] [-m FOCUS]\n       amux compact --nightly [AGENT -p N] [--dry]");
    return { help: true };
  }
  if (flags.nightly) {
    if (flags.force || flags["min-tokens"] != null || flags.m || flags.message || positional.length > 1) {
      throw new Error("Nightly compact uses dream.compact policy; no force or threshold overrides");
    }
    const result = await runNightlyCompact(ctx, flags, { onlyTarget: positional[0] ? { agent: positional[0], pane: flags.p ?? 0 } : null });
    if (!flags.dry && result.unresolved) process.exitCode = 1;
    return result;
  }
  // Focus instructions ride the slash command itself: `/compact <focus>` tells
  // the pane WHAT to preserve in the summary (contracts, task-file pointers,
  // current verify state) instead of letting it guess. Orchestrator-supplied,
  // since panes cannot compact themselves.
  const focus = flags.m ?? flags.message ?? "";
  const compactText = focus ? `/compact ${focus}` : "/compact";

  // Targeted mode: `amux compact <agent> [-p N] [-m "preserve ..."]`.
  // A non-numeric first positional is an agent name. An explicit target skips
  // the bulk thresholds (you chose the pane deliberately) but KEEPS the
  // working-pane guard — compacting mid-turn drops in-flight work.
  if (positional[0] != null && Number.isNaN(Number(positional[0]))) {
    return compactOnePane(ctx, String(positional[0]), flags, compactText);
  }

  const threshold = positional[0] != null ? parseInt(positional[0]) : 20;
  if (Number.isNaN(threshold) || threshold < 0 || threshold > 100) {
    console.error(`Invalid threshold '${positional[0]}'. Must be 0-100.`);
    process.exit(1);
  }
  const minTokens = flags["min-tokens"] != null ? parseInt(flags["min-tokens"]) : COMPACT_MIN_TOKENS;
  const dry = !!flags.dry;
  const force = !!flags.force;

  const agents = listAgents(ctx.configPath);
  const targets = [];
  const skipped = [];

  for (const a of agents) {
    if (!(await hasSession(ctx, a.name))) continue;
    const panes = await listPanes(ctx, a.name);
    for (const p of panes) {
      // Coding-agent panes only. Engines hide behind their binary in tmux
      // (codex runs as `node`), so dialectFor cross-references agents.yaml cmd.
      const dialect = dialectFor(a, p);
      if (!isCodingDialect(dialect)) continue;
      const { status, context } = await inspectPane(ctx, a, p);
      if (!context) continue;
      if (context.percent < threshold) continue;
      if (context.tokens < minTokens) continue;
      const unsafe = isCompactUnsafe(status);
      if (unsafe && !force) {
        skipped.push({ agent: a.name, pane: p.index, dialect, context, status });
        continue;
      }
      targets.push({ agent: a.name, pane: p.index, dialect, context, status });
    }
  }

  console.log(`Threshold: ≥${threshold}% and ≥${formatTokens(minTokens)} tokens  |  Action: ${dry ? "dry-run" : "compact"}${force ? "  |  FORCE (will compact working panes)" : ""}`);

  if (targets.length) {
    console.log(`\nCompacting ${targets.length} pane(s):`);
    for (const t of targets) {
      console.log(`  ${t.agent.padEnd(10)} p${t.pane}  ${t.context.percent}%  ${formatTokens(t.context.tokens)}  (${t.status})`);
    }
  }
  if (skipped.length) {
    console.log(`\nSkipped ${skipped.length} pane(s), currently active. Use --force to include:`);
    for (const s of skipped) {
      console.log(`  ${s.agent.padEnd(10)} p${s.pane}  ${s.context.percent}%  ${formatTokens(s.context.tokens)}  (${s.status})`);
    }
  }
  if (!targets.length && !skipped.length) {
    console.log(`\nNo claude/codex panes above ${threshold}%. Nothing to do.`);
    return;
  }

  if (dry || !targets.length) return;

  console.log("");
  for (const t of targets) {
    try {
      // Mirror to Discord with an "amux:compact" source tag so channel
      // watchers can tell this was a bulk-compact action vs a manual
      // /compact somebody typed. Transparency without noise.
      const sent = await sendToPane(ctx, t.agent, t.pane, compactText, { source: "amux:compact" });
      if (sent?.delivered) console.log(`✓ ${t.agent} p${t.pane}: ${compactText} sent`);
      else console.log(`✗ ${t.agent} p${t.pane}: ${sent?.blocked ? "blocked by park-guard" : "delivery not acknowledged"}`);
    } catch (err) {
      console.log(`✗ ${t.agent} p${t.pane}: ${err.message}`);
    }
  }
  console.log(`\nNote: /compact runs asynchronously in each pane. Run 'amux top' in a minute to see new values.`);
}

/**
 * Compact ONE explicitly named pane: `amux compact <agent> [-p N] [-m "focus"]`.
 *
 * WHAT: Sends `/compact [focus]` to a single claude/codex pane, with the same
 * Discord mirroring as bulk mode.
 * WHY: Bulk mode is threshold-driven and touches EVERY qualifying pane — but
 * before handing a pane a heavy new brief, the orchestrator wants to compact
 * exactly that pane and steer what the summary preserves. Thresholds don't
 * gate here (the human/orchestrator chose the pane); the working-pane guard
 * still does, because compacting mid-turn drops in-flight work.
 */
async function compactOnePane(ctx, name, flags, compactText) {
  const paneIdx = Number.isFinite(flags.p) ? flags.p : 0;
  const agents = listAgents(ctx.configPath);
  const a = agents.find((x) => x.name === name);
  if (!a) {
    console.error(`Unknown agent '${name}'. Known: ${agents.map((x) => x.name).join(", ")}`);
    process.exit(1);
  }
  if (!(await hasSession(ctx, name))) {
    console.error(`Agent '${name}' has no running session.`);
    process.exit(1);
  }
  const panes = await listPanes(ctx, name);
  const p = panes.find((x) => x.index === paneIdx);
  if (!p) {
    console.error(`No pane ${paneIdx} in '${name}' (panes: ${panes.map((x) => x.index).join(", ")}).`);
    process.exit(1);
  }
  const dialect = dialectFor(a, p);
  if (!isCodingDialect(dialect)) {
    console.error(`${name} p${paneIdx} is not a coding-agent pane: /compact would land in a shell.`);
    process.exit(1);
  }
  const { status, context } = await inspectPane(ctx, a, p);
  const ctxStr = context ? `${context.percent}% ${formatTokens(context.tokens)}` : "context unknown";
  if (isCompactUnsafe(status) && !flags.force) {
    console.error(
      `${name} p${paneIdx} is ${status} (${ctxStr}), compacting mid-turn drops in-flight work. Use --force to override.`
    );
    process.exit(1);
  }
  if (context && context.tokens < COMPACT_MIN_TOKENS) {
    console.log(
      `Note: ${name} p${paneIdx} holds only ${formatTokens(context.tokens)}, sending anyway (explicit target).`
    );
  }
  if (flags.dry) {
    console.log(`[dry] ${name} p${paneIdx} (${status}, ${ctxStr}) ← ${compactText}`);
    return;
  }
  const sent = await sendToPane(ctx, name, paneIdx, compactText, { source: "amux:compact" });
  if (!sent?.delivered) {
    console.error(`${name} p${paneIdx}: ${sent?.blocked ? "blocked by park-guard" : "delivery not acknowledged"}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${name} p${paneIdx}: ${compactText} sent  (was ${status}, ${ctxStr})`);
  console.log(`Note: /compact runs asynchronously. Run 'amux top' in a minute to see new values.`);
}
