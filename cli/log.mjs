import { getAgent, validateAgentPane } from "./config.mjs";
import { hasSession } from "./tmux.mjs";
import { groupNativeTurns } from "../channels/native-runtime-watcher.mjs";
import { readLastTurns, parseSinceArg, panePathFor } from "../core/jsonl-reader.mjs";
import { readAlternateTurns } from "../core/alternate-session-reader.mjs";
import { extractText } from "../core/extract.mjs";
import { cmdConversationLog } from "./conversation.mjs";

/** WHAT: Formats diagnostic provider turns. WHY: Keeps raw tool detail outside the normal conversation view. */
function formatTurnsForDisplay(turns) {
  const out = [];
  for (let i = 0; i < turns.length; i++) {
    const t = turns[i];
    const sep = "─".repeat(60);
    const ts = t.timestamp ? ` (${t.timestamp})` : "";
    out.push(sep);
    out.push(`Turn ${i + 1} of ${turns.length}${ts}`);
    out.push(sep);
    out.push(`> ${t.userPrompt.split("\n")[0]}${t.userPrompt.includes("\n") ? " …" : ""}`);
    for (const item of t.items) {
      out.push("");
      if (item.type === "tool") out.push(`  [tool] ${item.content}`);
      else out.push(item.content);
    }
    out.push("");
  }
  return out.join("\n");
}


/** WHAT: Reads one configured engine's diagnostic history. WHY: Keeps existing engine decoding behind the explicit raw route. */
function readLastTurnsForPane(agent, pane, dir, options) {
  return readAlternateTurns(agent.panes?.[pane]?.cmd || "", dir, options) || readLastTurns(dir, options);
}

/** WHAT: Routes normal conversation reads and explicit raw diagnostics. WHY: Keeps archived output reachable without starting a pane. */
export async function cmdLog(name, flags, ctx) {
  const pane = flags.p || 0;

  try { validateAgentPane(ctx.configPath, name, pane); }
  catch (err) { console.error(err.message); process.exit(1); }

  if (!flags.raw && !flags.tmux && !flags.text && !flags.t) return cmdConversationLog(name, flags, ctx);
  if ((!flags.raw || flags.tmux || flags.full || flags.f || flags.text || flags.t) && !(await hasSession(ctx, name))) {
    console.error(`No live runtime for '${name}'. Run 'amux ${name}' to start or provision it.`);
    process.exit(1);
  }

  const configured = getAgent(ctx.configPath, name);
  if (configured.backend === "native" && !flags.tmux && !flags.text && !flags.t) {
    const snapshot = await ctx.agent.nativeRuntime.history(name, pane);
    let turns = groupNativeTurns(snapshot.events);
    const since = parseSinceArg(flags.since);
    if (flags.since && !since) {
      console.error(`invalid --since '${flags.since}'. Use ISO or relative ("30min", "2h", "1d").`);
      process.exit(1);
    }
    if (since) turns = turns.filter((turn) => turn.endAt >= since.getTime());
    if (flags.grep) {
      let pattern;
      try { pattern = new RegExp(flags.grep, "i"); }
      catch (error) {
        console.error(`invalid --grep regex: ${error.message}`);
        process.exit(1);
      }
      turns = turns.filter((turn) => pattern.test(`${turn.user}\n${turn.items.map((item) => item.content).join("\n")}`));
    }
    turns = turns.slice(-(flags.n || 3));
    if (!turns.length) {
      console.log("(no native turns found)");
      return;
    }
    for (const turn of turns) {
      console.log(`USER  ${new Date(turn.userAt || turn.endAt).toISOString()}`);
      console.log(turn.user);
      console.log("ASSISTANT");
      console.log(turn.items.map((item) => item.type === "tool" ? `[tool] ${item.content}` : item.content).join("\n\n"));
      console.log("");
    }
    if (flags.full || flags.f) {
      console.log("═══ native runtime ═══");
      console.log(await ctx.agent.capturePane(name, pane));
    }
    return;
  }

  // --- legacy mode: --text / -t (old default behavior, kept for compat) ---
  if (flags.text || flags.t) {
    const raw = await ctx.agent.capturePane(name, pane, 5000);
    const text = extractText(raw);
    console.log(text || "(empty)");
    return;
  }

  // --- raw tmux capture: --tmux (no filtering, configurable scrollback) ---
  if (flags.tmux && !flags.full && !flags.f) {
    const lines = flags.s || flags.n || 200;
    const raw = await ctx.agent.capturePane(name, pane, lines);
    console.log(raw);
    return;
  }

  // Resolve paneDir for jsonl lookup. Each pane runs claude from its own
  // worktree (`${agent.dir}/.agents/${paneIdx}`), so claude's session store
  // is keyed off that subdir, not the agent root. Use panePathFor to match
  // the convention used by readAllTurnsAcrossPanes / cmdDone.
  const agent = configured;
  const paneDir = panePathFor(agent, pane);

  // --- full: jsonl history + current tmux state ---
  if (flags.full || flags.f) {
    const since = parseSinceArg(flags.since);
    const grep = flags.grep ? new RegExp(flags.grep, "i") : null;
    const limit = flags.n || 3;
    const jsonl = readLastTurnsForPane(agent, pane, paneDir, { limit, since, grep });
    if (jsonl && jsonl.turns.length) {
      console.log(`═══ jsonl (${jsonl.jsonlFile}) ═══`);
      console.log(formatTurnsForDisplay(jsonl.turns));
    } else {
      console.log(`═══ jsonl: no turns found ═══`);
    }
    const lines = flags.s || 200;
    const raw = await ctx.agent.capturePane(name, pane, lines);
    console.log(`\n═══ tmux (last ${lines} lines) ═══`);
    console.log(raw);
    return;
  }

  // --- default: structured jsonl, last N turns ---
  const since = parseSinceArg(flags.since);
  if (flags.since && !since) {
    console.error(`invalid --since '${flags.since}'. Use ISO or relative ("30min", "2h", "1d").`);
    process.exit(1);
  }
  let grep = null;
  if (flags.grep) {
    try { grep = new RegExp(flags.grep, "i"); }
    catch (err) {
      console.error(`invalid --grep regex: ${err.message}`);
      process.exit(1);
    }
  }
  const limit = flags.n || 3;
  const jsonl = readLastTurnsForPane(agent, pane, paneDir, { limit, since, grep });
  if (!jsonl) {
    console.error(
      `no jsonl found for '${paneDir}'. ` +
      `Pane may not have run claude/codex/kimi/qwen yet, or session is in a different cwd. ` +
      `Try --tmux for raw capture.`,
    );
    process.exit(1);
  }
  if (!jsonl.turns.length) {
    const filters = [];
    if (flags.since) filters.push(`--since ${flags.since}`);
    if (flags.grep) filters.push(`--grep '${flags.grep}'`);
    const filterMsg = filters.length ? ` matching ${filters.join(" ")}` : "";
    console.log(`(no turns${filterMsg} in ${jsonl.jsonlFile})`);
    return;
  }
  console.log(formatTurnsForDisplay(jsonl.turns));
}
