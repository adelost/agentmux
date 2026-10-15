// Dream's shadow run on the conversation log: the same windows and fair packing
// as the real packet, compared side by side before Dream switches its source
// (docs/CONVERSATION-LOG.md). It never sends anything or moves a receipt.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { readWindow } from "./ask-ledger.mjs";
import { answeredShare } from "./dream-conversation.mjs";
import { buildDreamBatch, collectDreamSources } from "./dream-summarizer.mjs";
import { DREAM_CATCH_UP_MS } from "./dream-turn-selection.mjs";

const keyOf = (source) => `${source.agent}:${source.pane}`;

/** WHAT: Caches journal reads by pane and window. WHY: The shadow's journal fallback reuses the real run's reads instead of scanning large journals twice. */
export function memoizeHistory(readHistory) {
  const cache = new Map();
  return (engine, dir, options = {}) => {
    const key = [engine, dir, options.since?.toISOString?.() ?? ""].join("\u0000");
    if (!cache.has(key)) {
      try { cache.set(key, { value: readHistory(engine, dir, options) }); }
      catch (error) { cache.set(key, { error }); }
    }
    const hit = cache.get(key);
    if (hit.error) throw hit.error;
    return hit.value;
  };
}

function packetFacts(batch, observed) {
  return {
    bytes: Buffer.byteLength(batch.sourceText),
    included: batch.included.map(keyOf),
    omitted: batch.omitted.map((source) => `${keyOf(source)} ${source.omitReason}`),
    unreadable: observed.unreadable.map(keyOf),
  };
}

/**
 * WHAT: Builds the conversation-log packet beside the real one and compares them.
 * WHY: The source switch waits for evidence: bytes, panes, and how many human asks the log answers.
 */
export function dreamShadow({ agents, sinceMs, receipts, readHistory, current, dateKey, nowMs = Date.now(), logPath }) {
  const log = readWindow({ path: logPath, since: sinceMs - DREAM_CATCH_UP_MS });
  const observed = collectDreamSources(agents, sinceMs, {
    receipts, readHistory, now: nowMs, conversation: { log, partialWindow: true },
  });
  const batch = buildDreamBatch(observed.sources, dateKey);
  const fromLog = observed.sources.filter((source) => source.source === "conversation-log");
  return {
    dateKey,
    at: new Date(nowMs).toISOString(),
    coverageStart: Number.isFinite(log.coverageStartMs) ? new Date(log.coverageStartMs).toISOString() : null,
    current: packetFacts(current.batch, current.observed),
    conversation: {
      ...packetFacts(batch, observed),
      fromLog: fromLog.map(keyOf),
      partialWindow: fromLog.filter((source) => source.historyComplete === false).map(keyOf),
    },
    answered: answeredShare(log, { sinceMs: Math.max(sinceMs, log.coverageStartMs), nowMs }),
  };
}

/** WHAT: Formats the comparison as a few lines. WHY: Keeps `amux dream --dry` and the nightly log readable. */
export function formatDreamShadow(report) {
  const { current, conversation, answered } = report;
  const share = answered.share == null ? "no settled human asks yet" : `${(answered.share * 100).toFixed(1)} %`;
  return [
    `Shadow on the conversation log (posts since ${report.coverageStart || "never"}):`,
    `- current packet: ${current.bytes} bytes, ${current.included.length} pane(s), omitted ${current.omitted.length}, unreadable ${current.unreadable.length}`,
    `- log packet: ${conversation.bytes} bytes, ${conversation.included.length} pane(s), ${conversation.fromLog.length} from the log`
      + ` (${conversation.partialWindow.length} with a window older than the log), omitted ${conversation.omitted.length}, unreadable ${conversation.unreadable.length}`,
    `- human asks answered by a post: ${answered.answered} of ${answered.asked} (${share}; health only, not a source-switch gate)`,
  ];
}

/** WHAT: Stores one shadow comparison. WHY: Keeps the night's evidence for the switch decision after the log line scrolls away. */
export function writeDreamShadow(report, { dir = join(homedir(), ".agentmux", "dream-shadow") } = {}) {
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const path = join(dir, `${report.at.replace(/[:.]/gu, "-")}.json`);
  writeFileSync(path, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 });
  return path;
}
