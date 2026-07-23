// Per-pane observation: dialect resolution plus the status/preview/context
// probe behind `amux ps`. Extracted from commands.mjs so the Kimi journal
// truth and the file cap both live in one place.

import { detectPaneStatus } from "./format.mjs";
import { stripAnsi } from "../lib.mjs";
import { latestPaneStatesCached, mergeStatus } from "../core/events.mjs";
import { getContextFromPane, getContextPercent } from "../core/context.mjs";
import { latestJsonlMtime, panePathFor } from "../core/jsonl-reader.mjs";
import { alternateEngineForCommand, latestAlternateMtime } from "../core/alternate-session-reader.mjs";
import { groupNativeTurns } from "../channels/native-runtime-watcher.mjs";
import { nativeContextReading } from "../core/suggestions-context-telemetry.mjs";
import { kimiObservedStatus } from "../core/kimi-status-truth.mjs";

// `node` as a tmux process name is too generic to trust as Codex by itself,
// so we resolve its dialect via agents.yaml cmd field instead — see
// dialectFor().
const CONTEXT_DIALECT = { claude: "claude", codex: "codex", kimi: "kimi", "kimi-code": "kimi" };

/** WHAT: Resolves a pane's coding-agent dialect from process name and configured cmd. WHY: Prevents a generic node process from hiding its true engine. */
export function dialectFor(agent, pane) {
  const direct = CONTEXT_DIALECT[pane.command];
  if (direct) return direct;
  const cmd = agent?.panes?.[pane.index]?.cmd || "";
  const alternate = alternateEngineForCommand(cmd);
  if (alternate) return alternate;
  if (/claude/i.test(cmd)) return "claude";
  return null;
}

/** WHAT: Reads one pane's canonical context and preview. WHY: Keeps native and tmux engines behind one top-row contract. */
export async function inspectPane(ctx, agent, pane) {
  if (agent.backend === "native") {
    try {
      const snapshot = await ctx.agent.nativeRuntime.history(agent.name, pane.index);
      const turns = groupNativeTurns(snapshot.events);
      const latest = turns.at(-1);
      const preview = latest?.items?.filter((item) => item.type === "text").at(-1)?.content || "";
      const context = nativeContextReading(snapshot);
      return {
        status: snapshot.agent.running ? "working" : "idle",
        preview: preview.replace(/\s+/g, " ").trim(),
        context,
      };
    } catch {
      return { status: "unknown", preview: "native runtime offline", context: null };
    }
  }
  // Single capture per pane. We used to call getPaneStatus (a 30-line
  // capture-pane) AND capturePane(100) — two round-trips to the SINGLE-
  // THREADED tmux server, which serializes them server-side no matter how
  // parallel the client is. detectPaneStatus only inspects the last ~15
  // lines, so deriving status from the same 100-line capture is identical
  // output for half the tmux calls — the actual lever for `amux ps` latency.
  let content = "";
  try { content = await ctx.agent.capturePane(agent.name, pane.index, 100); }
  catch {}
  // Same scrape+hook merge as getPaneStatus, applied to the one capture we
  // already have. Capture failure (dead pane) stays "unknown" unmerged.
  let status = content
    ? mergeStatus(detectPaneStatus(stripAnsi(content)),
                  latestPaneStatesCached().get(`${agent.name}:${pane.index}`)).status
    : "unknown";
  const lines = stripAnsi(content).split("\n").filter((l) => l.trim());
  const dialect = dialectFor(agent, pane);
  // Use the worktree pane dir, not agent.dir — same fix as cmdLog (399915f).
  // Claude Code stores its session jsonl per-cwd; each pane runs in
  // .agents/N, so getContextFromPane's max-tokens fallback must read from
  // the worktree slug, not the parent project slug.
  const paneDir = panePathFor(agent, pane.index);
  // Cheap tmux-tail preview as a fallback. The meaningful jsonl-based preview
  // is read lazily in the render loop, but ONLY for panes that get expanded
  // (active / has-context) — readLastTurns is a synchronous full-file parse,
  // so reading it for all ~40 panes here would serialize and dwarf the
  // parallel tmux probes. Reserve it for the handful that actually display.
  const preview = (lines[lines.length - 1] || "").trim();
  // Claude: status-bar parser (capture-pane already in `content`).
  // Codex: read directly from codex jsonl (no status-bar equivalent).
  let context = null;
  if (dialect === "claude") {
    context = getContextFromPane(content, paneDir);
  } else if (dialect === "codex" || dialect === "kimi") {
    context = getContextPercent(paneDir, dialect);
  }

  // Live-activity overlay: tmux-only detection can't tell an active spinner
  // ("✻ Sautéed for X" still counting up) from a frozen one (post-turn
  // residue) — same shape, same regex match. Cross-check jsonl mtime: a
  // jsonl event written recently means the agent is generating right now,
  // regardless of what the prompt-line looks like. Only override when the
  // tmux-detection said idle/unknown so we don't shadow real permission/
  // menu/resume modals.
  //
  // Window: 60s (matches `amux done`'s isRunningNow default). Earlier
  // values (10s, then 30s) caused visible "pendling" between 💤/🟢 in
  // `amux ps` because Claude regularly pauses 30-50s between assistant
  // text + tool calls + deep thinking; the pane is still working but
  // jsonl mtime falls outside the window.
  if (dialect && (status === "idle" || status === "unknown")) {
    if (dialect === "kimi") {
      // Kimi's Wire journal lives in the Kimi home, not the pane dir, so the
      // mtime overlay below can never see a quiet thinking phase. The Wire
      // busy state is the same truth delivery uses — ps agrees by construction.
      status = kimiObservedStatus(status, paneDir, { liveCommand: pane.command });
    } else {
      const mtimeMs = latestAlternateMtime(agent?.panes?.[pane.index]?.cmd, paneDir)
        || latestJsonlMtime(paneDir);
      if (mtimeMs && Date.now() - mtimeMs < 60_000) {
        status = "working";
      }
    }
  }
  return { status, preview, context };
}
