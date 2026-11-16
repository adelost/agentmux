// Manual compact and the shared nightly maintenance entry.
import { listAgents } from "./config.mjs";
import { hasSession, listPanes } from "./tmux.mjs";
import { sendRecordedCompact } from "./manual-compact.mjs";
import { isCodingDialect } from "../core/dialects.mjs";
import { dialectFor, inspectPane } from "./inspect-pane.mjs";
import { isCompactUnsafe } from "../core/pane-status.mjs";
import { formatTokens } from "./format.mjs";
import { runNightlyCompact } from "./nightly-compact.mjs";
import { AT_WORK_COMPACT_TOKENS, CONTEXT_COST_POLICY, PAUSE_COMPACT_POLICY } from "../policies/context-cost.mjs";
import { execSync } from "node:child_process";
import { detectPaneAddress } from "../core/sender-detect.mjs";
import { latestPaneSessionIdentity } from "../core/native-session-identity.mjs";
import { latestJournalCompactMs } from "../core/pause-compact.mjs";
import { SELF_COMPACT_POLICY, atWorkDetail, createSelfCompactStore } from "../core/self-compact.mjs";
import { captureJsonlAppendCursor } from "../core/jsonl-append-cursor.mjs";
import { contextMaintenanceAttempt } from "../core/context-maintenance.mjs";
import { panePathFor } from "../core/jsonl-reader.mjs";
import { readFileSync, statSync } from "node:fs";

const COMPACT_MIN_TOKENS = CONTEXT_COST_POLICY.maxTokens;
const ownPane = () => detectPaneAddress(process.env, command => execSync(command, { encoding: "utf8", timeout: 2000 }));
/** WHAT: Checks whether a pane, not a person, runs this command. WHY: Keeps the emergency override and the 400k floor on agents while a person's shell stays free. */
const calledFromPane = (caller, env) => Boolean(caller || env.TMUX || env.AMUX_AGENT_NAME);

/** WHAT: Routes manual and nightly compaction. WHY: Keeps explicit targeting separate from absolute-token admission. */
export async function cmdCompact(ctx, flags = {}, positional = [], selfOptions = {}) {
  if (flags.help || flags.h) {
    console.log(`Usage: amux compact [AGENT -p N] [--dry] [--min-tokens N] [-m FOCUS]\n       amux compact --self [-m HANDOFF | --continue-file FILE] [--no-resume]\n       amux compact --nightly [AGENT -p N] [--dry]\n--override-failed "reason": targeted emergency retry, human or sandman:0 only; exact FAILED/UNVERIFIED receipt audited.\nBulk default: over ${COMPACT_MIN_TOKENS} tokens. Percent thresholds are not supported.\nCalled from a pane, any compact (--self in every form, a targeted pane, bulk, --min-tokens) runs only above ${AT_WORK_COMPACT_TOKENS} tokens:\na pane at work is not compacted under that (owner's decision 16 Nov 2026). Under it nothing is stored, and that is not an error:\nAMUX compacts a pane by itself once it has rested (Claude after ${CONTEXT_COST_POLICY.idleMs / 60_000} min from ${CONTEXT_COST_POLICY.maxTokens / 1000}k, Codex after ${PAUSE_COMPACT_POLICY.codexIdleMs / 60_000} min from ${PAUSE_COMPACT_POLICY.codexMinTokens / 1000}k).\n--self: this pane asks to be compacted when its turn ends (a stage boundary), at most once per ${SELF_COMPACT_POLICY.spacingMs / 60_000} minutes,\nnever while a subagent or job writes.\nAfter a verified compact, its saved handoff continues once through the durable queue. New input supersedes it.\n--no-resume requests maintenance only. Targeting your own pane also uses this safe path, even with --force.`);
    return { help: true };
  }
  const env = selfOptions.env ?? process.env;
  let override = null;
  if (flags["override-failed"] !== undefined) {
    const caller = (selfOptions.detect ?? ownPane)();
    if (calledFromPane(caller, env) && caller?.key !== "sandman:0") {
      throw new Error("override-failed is only for a human or sandman:0, never an automatic caller");
    }
    const reason = flags["override-failed"];
    if (typeof reason !== "string" || !reason.trim() || reason.length > 500 || flags.self || flags.nightly
        || positional.length !== 1 || !Number.isSafeInteger(flags.p)) {
      throw new Error('Use amux compact AGENT -p N --override-failed "reason"');
    }
    override = { actor: caller?.key || "human", reason };
  }
  if (flags.self) return requestSelfCompact(ctx, flags, selfOptions);
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
  // working-pane guard: compacting mid-turn drops in-flight work. A pane
  // that targets another pane compacts it only above 400k, in compactOnePane.
  if (positional[0] != null && Number.isNaN(Number(positional[0]))) {
    const caller = (selfOptions.detect ?? ownPane)();
    if (caller?.session === positional[0] && caller.pane === (Number.isFinite(flags.p) ? flags.p : 0)) {
      return requestSelfCompact(ctx, flags, selfOptions);
    }
    return compactOnePane(ctx, String(positional[0]), flags, compactText, override, calledFromPane(caller, env));
  }

  if (positional[0] != null) throw new Error("Percentage thresholds are no longer supported; use --min-tokens N");
  // Row 214: a pane that compacts other panes cannot know that they rest, so its bulk pass starts above 400k.
  const fromPane = calledFromPane((selfOptions.detect ?? ownPane)(), env);
  const defaultMinTokens = fromPane ? AT_WORK_COMPACT_TOKENS : COMPACT_MIN_TOKENS;
  const minTokens = flags["min-tokens"] != null ? Number(flags["min-tokens"]) : defaultMinTokens;
  if (!Number.isSafeInteger(minTokens) || minTokens < 1) throw new Error("--min-tokens requires a positive integer");
  if (fromPane && minTokens < AT_WORK_COMPACT_TOKENS) {
    throw new Error(`--min-tokens ${minTokens} is under ${AT_WORK_COMPACT_TOKENS}: a pane compacts other panes only above that. AMUX compacts a resting pane by itself.`);
  }
  const dry = !!flags.dry;
  const force = !!flags.force;
  if (dry) printSelfRequests(createSelfCompactStore().list());

  const agents = listAgents(ctx.configPath);
  const targets = [];
  const skipped = [];
  const fenced = [];

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
      if (!Number.isFinite(context.tokens) || context.tokens <= minTokens) continue;
      const attempt = compactAttemptWithoutNewWork(ctx.state, a, p.index, dialect);
      if (attempt) {
        fenced.push({ agent: a.name, pane: p.index, context, attempt: attempt.status });
        continue;
      }
      const unsafe = isCompactUnsafe(status);
      if (unsafe && !force) {
        skipped.push({ agent: a.name, pane: p.index, dialect, context, status });
        continue;
      }
      targets.push({ agent: a.name, agentConfig: a, pane: p.index, dialect, context, status });
    }
  }

  console.log(`Threshold: >${formatTokens(minTokens)} tokens  |  Action: ${dry ? "dry-run" : "compact"}${force ? "  |  FORCE (will compact working panes)" : ""}`);

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
  if (fenced.length) {
    console.log(`\nSkipped ${fenced.length} pane(s), no new work since the last compact. Target one pane to override:`);
    for (const f of fenced) {
      console.log(`  ${f.agent.padEnd(10)} p${f.pane}  ${f.context.percent}%  ${formatTokens(f.context.tokens)}  (compact ${f.attempt})`);
    }
  }
  if (!targets.length && !skipped.length) {
    if (!fenced.length) console.log(`\nNo claude/codex panes above ${formatTokens(minTokens)} tokens. Nothing to do.`);
    return;
  }

  if (dry || !targets.length) return;

  console.log("");
  for (const t of targets) {
    try {
      // Mirror to Discord with an "amux:compact" source tag so channel
      // watchers can tell this was a bulk-compact action vs a manual
      // /compact somebody typed. Transparency without noise.
      const sent = await sendRecordedCompact(ctx, t.agentConfig, t.pane, t.dialect, compactText, { override });
      if (sent?.delivered) console.log(`✓ ${t.agent} p${t.pane}: ${compactText} sent`);
      else console.log(`✗ ${t.agent} p${t.pane}: ${sent?.reason || (sent?.blocked ? "delivery blocked" : "delivery not acknowledged")}`);
    } catch (err) {
      console.log(`✗ ${t.agent} p${t.pane}: ${err.message}`);
    }
  }
  console.log(`\nNote: /compact runs asynchronously in each pane. Run 'amux top' in a minute to see new values.`);
}

/**
 * WHAT: Reads the shared compact fence of a context that has had no work since that compact.
 * WHY: Claude reports the pre-compact size until its next turn, so size alone sent
 * api:2 a second /compact a day after its verified one (2026-10-12). Pause and
 * nightly compaction already read this fence; bulk mode now does too.
 */
function compactAttemptWithoutNewWork(state, agent, paneIndex, engine) {
  const identity = latestPaneSessionIdentity(engine, panePathFor(agent, paneIndex));
  return contextMaintenanceAttempt(state, agent.name, paneIndex, identity);
}

/**
 * Compact ONE explicitly named pane: `amux compact <agent> [-p N] [-m "focus"]`.
 *
 * WHAT: Sends `/compact [focus]` to a single claude/codex pane, with the same
 * Discord mirroring as bulk mode.
 * WHY: Bulk mode is threshold-driven and touches EVERY qualifying pane — but
 * before handing a pane a heavy new brief, the orchestrator wants to compact
 * exactly that pane and steer what the summary preserves. Thresholds don't
 * gate a person's target (the human chose the pane); a pane's target is
 * compacted only above 400k (Row 214). The working-pane guard gates both,
 * because compacting mid-turn drops in-flight work.
 */
async function compactOnePane(ctx, name, flags, compactText, override = null, fromPane = false) {
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
  // Row 214: a neighbour cannot know that this pane rests, so it compacts it only above 400k, also with --force or an override.
  if (fromPane && !(context?.tokens > AT_WORK_COMPACT_TOKENS)) {
    const detail = atWorkDetail(context?.tokens);
    console.log(`No compact for ${name} p${paneIdx} (at-work): ${detail}.`);
    return { ok: false, cell: "at-work", detail };
  }
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
  // Codex has no focus argument. Long /compact prose becomes authored work,
  // not evidence of a compact. Self-targets above preserve it as a handoff.
  if (dialect === "codex" && compactText !== "/compact") {
    throw new Error("Codex /compact takes no focus. The pane must use amux compact --self -m HANDOFF or --continue-file FILE.");
  }
  const sent = await sendRecordedCompact(ctx, a, paneIdx, dialect, compactText, { override });
  if (!sent?.delivered) {
    console.error(`${name} p${paneIdx}: ${sent?.reason || (sent?.blocked ? "delivery blocked" : "delivery not acknowledged")}`);
    process.exitCode = 1;
    return;
  }
  console.log(`✓ ${name} p${paneIdx}: ${compactText} sent  (was ${status}, ${ctxStr})`);
  console.log(`Note: /compact runs asynchronously. Run 'amux top' in a minute to see new values.`);
}

function printSelfRequests(requests) {
  if (!requests.length) return;
  console.log(`Self-compact requests, run when each pane's turn ends:`);
  for (const request of requests) {
    console.log(`  ${request.agent.padEnd(10)} p${request.pane}  asked ${request.requestedAt} at ${formatTokens(request.tokens)}`
      + `${request.focus ? `  focus: ${request.focus}` : ""}`);
  }
  console.log("");
}

/**
 * WHAT: Stores this pane's checkpoint compact and optional handoff.
 * WHY: Keeps active work untouched until the bridge verifies a safe pause.
 */
export async function requestSelfCompact(ctx, flags, {
  detect = ownPane,
  store = createSelfCompactStore(),
  identityFor = latestPaneSessionIdentity,
  readContext = async (agent, pane) => {
    const panes = await listPanes(ctx, agent.name);
    const found = panes.find((entry) => entry.index === pane);
    return found ? (await inspectPane(ctx, agent, found)).context : null;
  },
  lastCompactAt = (engine, dir) => {
    const identity = latestPaneSessionIdentity(engine, dir);
    return identity?.path ? latestJournalCompactMs(identity.path) : null;
  },
} = {}) {
  const address = detect();
  if (!address) throw new Error("amux compact --self runs inside an amux pane: no pane identity in this environment");
  const agent = listAgents(ctx.configPath).find((entry) => entry.name === address.session);
  const engine = agent && dialectFor(agent, { index: address.pane });
  if (!agent || !["claude", "codex"].includes(engine)) throw new Error(`${address.key} is not a configured Claude or Codex pane`);
  const context = await readContext(agent, address.pane);
  const focus = String(flags.m ?? flags.message ?? "");
  let continuation = focus;
  if (flags["continue-file"]) {
    if (statSync(flags["continue-file"]).size > 64 * 1024) throw new Error("self-compact handoff exceeds 64 KiB");
    continuation = new TextDecoder("utf-8", { fatal: true }).decode(readFileSync(flags["continue-file"]));
    if (!continuation.trim()) throw new Error("self-compact handoff file is empty");
  }
  if (flags["no-resume"]) continuation = "";
  if (Buffer.byteLength(continuation) > 64 * 1024) throw new Error("self-compact handoff exceeds 64 KiB");
  const dir = `${agent.dir}/.agents/${address.pane}`;
  const identity = continuation ? identityFor(engine, dir) : null;
  if (continuation && !identity?.path) throw new Error("self-compact handoff requires this pane's current session");
  if (flags.dry) { console.log(`[dry] ${address.key}: compact after this turn, ${continuation ? "then queue the exact handoff once" : "maintenance only"}`); return { dry: true }; }
  const result = store.request({ agent: agent.name, pane: address.pane, focus, tokens: context?.tokens,
    lastCompactAt: lastCompactAt(engine, dir), continuation,
    identity: identity ? { ...identity, engine, dir } : null,
    cursor: identity ? captureJsonlAppendCursor("self-compact-request-v1", [identity.path]) : null });
  if (result.cell === "at-work") {
    console.log(`No compact for ${address.key} (at-work): ${result.detail}.`);
    return result;
  }
  if (!result.ok) {
    console.log(`Self-compact refused for ${address.key} (${result.cell}): ${result.detail}.`);
    process.exitCode = 1;
    return result;
  }
  console.log(`Self-compact requested for ${address.key} at ${formatTokens(context.tokens)}${focus ? `, focus: ${focus}` : ""}.`
    + " It runs when this turn ends; it waits while a subagent or job writes."
    + (continuation ? " After verification the exact handoff resumes once; newer input supersedes it." : " Maintenance only; no work prompt follows."));
  return result;
}
