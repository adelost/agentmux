import { defaultWorkspace } from "../core/runtime-defaults.mjs";
import { observeDreamHealth } from "../core/dream-health.mjs";

/** WHAT: Dispatches memory lookup or explicit maintenance. WHY: Keeps read-only context retrieval separate from compaction effects. */
export async function cmdMemory(ctx, subcommand, flags = {}) {
  const workspace = flags.workspace || process.env.OPENCLAW_WORKSPACE || defaultWorkspace(process.env.HOME);
  if (subcommand === "context") {
    const { readMemoryContext } = await import("../core/memory-context.mjs");
    const result = readMemoryContext(workspace, { pane: flags.pane || flags.p || null });
    console.log(flags.json ? JSON.stringify(result, null, 2) : result.text.trimEnd());
    return;
  }
  const {
    lintMemory, formatMemoryLint, formatMemoryStatus, readLatestMemoryCompact,
    writeMemoryDailyReport,
  } = await import("../core/memory-lint.mjs");
  if (subcommand === "status") {
    const result = lintMemory(workspace, { dreamHealth: observeDreamHealth(workspace, { configPath: ctx.configPath }) });
    result.compact = readLatestMemoryCompact(workspace);
    console.log(flags.json ? JSON.stringify(result, null, 2) : formatMemoryStatus(result));
    return;
  }
  if (subcommand === "lint") {
    const result = lintMemory(workspace, { dreamHealth: observeDreamHealth(workspace, { configPath: ctx.configPath }) });
    if (flags.reportDaily) writeMemoryDailyReport(workspace, result, { compacted: Number(flags.compacted) || 0 });
    console.log(flags.json ? JSON.stringify(result, null, 2) : formatMemoryLint(result));
    if (result.summary.warnings > 0) process.exitCode = 1;
    return;
  }
  if (subcommand === "compact") {
    const { compactMemory, formatMemoryCompact } = await import("../core/memory-compact.mjs");
    const result = await compactMemory(workspace, {
      dryRun: !!flags.dry,
      maxFiles: Number.isFinite(flags.max) ? flags.max : undefined,
    });
    console.log(flags.json ? JSON.stringify(result, null, 2) : formatMemoryCompact(result));
    if (result.failed.length > 0) process.exitCode = 1;
    return;
  }
  console.error(`Usage:
  amux memory context [-p agent:pane] [--json] [--workspace PATH]
  amux memory status [--json] [--workspace PATH]
  amux memory lint [--json] [--report-daily] [--compacted N] [--workspace PATH]
  amux memory compact --dry [--json] [--max N] [--workspace PATH]`);
  process.exitCode = 1;
}
