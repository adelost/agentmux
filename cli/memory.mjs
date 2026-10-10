import { defaultWorkspace } from "../core/runtime-defaults.mjs";
import { observeDreamHealth } from "../core/dream-health.mjs";

/** WHAT: Dispatches memory lookup or explicit maintenance. WHY: Keeps read-only context retrieval separate from compaction effects. */
export async function cmdMemory(ctx, subcommand, flags = {}) {
  const workspace = flags.workspace || process.env.OPENCLAW_WORKSPACE || defaultWorkspace(process.env.HOME);
  if (subcommand === "topics") {
    const { cmdMemoryTopics } = await import("./memory-topics.mjs");
    return cmdMemoryTopics(workspace, flags);
  }
  if (subcommand === "context") {
    const { readMemoryContext } = await import("../core/memory-context.mjs");
    const result = readMemoryContext(workspace, { pane: flags.pane || flags.p || null });
    console.log(flags.json ? JSON.stringify(result, null, 2) : result.text.trimEnd());
    return;
  }
  if (subcommand === "archive") {
    const { archiveMemory, formatMemoryArchive } = await import("../core/memory-archive.mjs");
    const result = archiveMemory(workspace, {
      dryRun: !flags.apply, max: Number.isFinite(flags.max) ? flags.max : undefined,
    });
    console.log(flags.json ? JSON.stringify(result, null, 2) : formatMemoryArchive(result));
    if (result.failed.length > 0) process.exitCode = 1;
    return;
  }
  if (subcommand === "bank") {
    const { bankMemory, formatMemoryBank } = await import("../core/memory-bank.mjs");
    const result = bankMemory(workspace, { dryRun: !!flags.dry });
    console.log(flags.json ? JSON.stringify(result, null, 2) : formatMemoryBank(result));
    if (result.skipped === "secret-pattern") process.exitCode = 1;
    return;
  }
  const {
    lintMemory, formatMemoryLint, formatMemoryStatus, readLatestMemoryCommit,
    writeMemoryDailyReport,
  } = await import("../core/memory-lint.mjs");
  if (subcommand === "status") {
    const result = lintMemory(workspace, { dreamHealth: observeDreamHealth(workspace, { configPath: ctx.configPath }) });
    result.compact = readLatestMemoryCommit(workspace, "compact");
    result.bank = readLatestMemoryCommit(workspace, "bank");
    console.log(flags.json ? JSON.stringify(result, null, 2) : formatMemoryStatus(result));
    return;
  }
  if (subcommand === "lint") {
    const result = lintMemory(workspace, { dreamHealth: observeDreamHealth(workspace, { configPath: ctx.configPath }) });
    if (flags.reportDaily) writeMemoryDailyReport(workspace, result, { archived: Number(flags.archived ?? flags.compacted) || 0 });
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
  amux memory topics [--json] [--workspace PATH]
  amux memory topics --publish FILE [--json] [--workspace PATH]
  amux memory status [--json] [--workspace PATH]
  amux memory lint [--json] [--report-daily] [--archived N] [--workspace PATH]
  amux memory archive [--dry|--apply] [--json] [--max N] [--workspace PATH]
  amux memory bank [--dry] [--json] [--workspace PATH]
  amux memory compact --dry [--json] [--max N] [--workspace PATH]`);
  process.exitCode = 1;
}
