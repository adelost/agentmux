import { existsSync } from "node:fs";
import { join } from "node:path";
import { parseFlags } from "./command-args.mjs";
import { getAgent, listAgents } from "./config.mjs";
import { CONTRACT_CHECK_ID, formatLintReport, lintRoots, resolvePathTarget } from "../core/contract-lint.mjs";

const FLAGS = {
  "all-agents": "boolean", changed: "boolean", strict: "boolean", baseline: "string",
  "update-baseline": "boolean", only: "string", skip: "string", limit: "number", help: "boolean", h: "boolean",
};

/** WHAT: Dispatches scoped lint checks. WHY: Prevents strict mode from silently disabling mandatory size guards. */
export async function cmdLint(args, ctx) {
  const { flags, positional } = parseFlags(args, FLAGS);
  if (flags.help || flags.h) {
    console.log(`Usage: amux lint [target...] [--all-agents] [--changed] [--strict]
  --changed                 Scan changes against the selected diff base
  --strict                  Fail on active findings; mandatory size guards cannot be skipped
  --baseline <path>         Suppress non-size findings recorded in baseline
  --update-baseline         Record non-size findings, never size exceptions
  --only contract           Select the known check
  --skip contract           Disable checks in advisory mode only
  --all-agents              Scan configured agent directories
  --limit N                 Findings per root (default 80)
Policy history always uses actual trunk, independent of AMUX_LINT_BASE_REF.`);
    return;
  }
  const only = flags.only ? String(flags.only) : null;
  const skip = flags.skip ? String(flags.skip).split(",").map((s) => s.trim()).filter(Boolean) : [];
  if ((only && only !== CONTRACT_CHECK_ID) || skip.some((name) => name !== CONTRACT_CHECK_ID)) {
    throw new Error("amux lint: unknown check name; available: contract");
  }
  if (skip.includes(CONTRACT_CHECK_ID)) {
    if (flags.strict) throw new Error("amux lint: strict mode cannot skip mandatory size guards");
    console.log("amux lint\nNo checks enabled (advisory mode).");
    return;
  }
  const roots = flags["all-agents"] ? listAgents(ctx.configPath).map((agent) => agent.dir)
    : positional.length ? positional.map((target) => {
      const path = resolvePathTarget(target, process.cwd());
      return existsSync(path) ? path : getAgent(ctx.configPath, target).dir;
    }) : [process.cwd()];
  if (!roots.length) {
    if (flags.strict) throw new Error("amux lint: strict mode has no roots to scan");
    console.log("amux lint\nNo roots to scan.");
    return;
  }
  let baselinePath = flags.baseline ? resolvePathTarget(flags.baseline, process.cwd()) : null;
  if (flags["update-baseline"] && !baselinePath) {
    if (roots.length !== 1) throw new Error("amux lint: --update-baseline needs --baseline for multiple roots");
    baselinePath = join(roots[0], ".amux-lint-baseline.json");
  }
  const results = lintRoots(roots, {
    changed: !!flags.changed, strict: !!flags.strict, baselinePath, updateBaseline: !!flags["update-baseline"],
  });
  if (flags["update-baseline"]) console.log(`Updated non-size baseline: ${baselinePath}\n`);
  console.log(formatLintReport(results, { baselinePath, limit: flags.limit || 80 }));
  if (flags.strict && results.some((r) => r.activeFindings.some((f) => f.sev !== "warn"))) process.exitCode = 1;
}
