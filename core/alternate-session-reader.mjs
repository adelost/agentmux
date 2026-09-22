// Structured session dispatch for non-Claude coding engines.

import {
  latestCodexJsonlInfo,
  latestCodexJsonlMtime,
  readLastTurnsCodex,
} from "./codex-jsonl-reader.mjs";
import {
  kimiWatchDir,
  latestKimiJsonlInfo,
  latestKimiJsonlMtime,
  readLastTurnsKimi,
} from "./kimi-jsonl-reader.mjs";
import {
  latestQwenJsonlInfo,
  latestQwenJsonlMtime,
  qwenWatchDir,
  readLastTurnsQwen,
} from "./qwen-jsonl-reader.mjs";

/** WHAT: Resolves non-Claude session engines. WHY: Keeps command parsing consistent across watcher and CLI. */
export function alternateEngineForCommand(command) {
  const value = String(command || "");
  if (/(?:^|[\/\s])qwen(?:\s|$)/iu.test(value)) return "qwen";
  if (/kimi(?:-code)?/iu.test(value)) return "kimi";
  if (/codex/iu.test(value)) return "codex";
  return null;
}

/** WHAT: Resolves a non-Claude journal reader. WHY: Keeps reader routing out of legacy orchestrator files. */
export function alternateSessionReader(command) {
  const engine = alternateEngineForCommand(command);
  if (engine === "codex") {
    return {
      readTurns: readLastTurnsCodex,
      latestMtime: latestCodexJsonlMtime,
      latestInfo: latestCodexJsonlInfo,
    };
  }
  if (engine === "kimi") {
    return {
      readTurns: readLastTurnsKimi,
      latestMtime: latestKimiJsonlMtime,
      latestInfo: latestKimiJsonlInfo,
    };
  }
  if (engine === "qwen") {
    return {
      readTurns: readLastTurnsQwen,
      latestMtime: latestQwenJsonlMtime,
      latestInfo: latestQwenJsonlInfo,
    };
  }
  return null;
}

/** WHAT: Reads non-Claude turns. WHY: Prevents callers from duplicating engine-specific journal branches. */
export function readAlternateTurns(command, paneDir, options) {
  return alternateSessionReader(command)?.readTurns(paneDir, options) || null;
}

/** WHAT: Reads non-Claude journal freshness. WHY: Keeps activity overlays aligned with their engine store. */
export function latestAlternateMtime(command, paneDir) {
  return alternateSessionReader(command)?.latestMtime(paneDir) || null;
}

/** WHAT: Resolves alternate journal watch roots. WHY: Keeps Kimi writes separate from Claude project paths. */
export function alternateWatchDir(command, paneDir) {
  const engine = alternateEngineForCommand(command);
  if (engine === "kimi") return kimiWatchDir(paneDir);
  if (engine === "qwen") return qwenWatchDir(paneDir);
  return null;
}
