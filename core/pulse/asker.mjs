// WHAT: Names who in agentmux called: up to three agentmux functions above the carriers that only pass the call on, innermost first.
// WHY: Keeps `amux pulse io` (tmux questions) and the read meter (file bytes) naming a cost by the same callers.

import { fileURLToPath } from "url";

const PACKAGE_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ASKER_FRAMES = 3;

/** WHAT: Names the caller chain of the current call, skipping `carriers` (paths from the package root) and node_modules. WHY: Shows which watcher pays. */
export function askerOf(carriers) {
  const limit = Error.stackTraceLimit;
  Error.stackTraceLimit = 20;
  const stack = new Error().stack ?? "";
  Error.stackTraceLimit = limit;
  const names = [];
  for (const line of stack.split("\n").slice(1)) {
    const frame = /at (?:async )?(?:(\S+) \()?((?:file:\/\/)?\/[^)]+?):\d+:\d+\)?$/u.exec(line.trim());
    const path = frame && (frame[2].startsWith("file:") ? fileURLToPath(frame[2]) : frame[2]);
    if (!path?.startsWith(PACKAGE_ROOT)) continue;
    const file = path.slice(PACKAGE_ROOT.length);
    if (file.startsWith("node_modules/") || carriers.has(file)) continue;
    names.push(`${frame[1] ?? "(anon)"} ${file}`);
    if (names.length === ASKER_FRAMES) break;
  }
  return names.length ? names.join(" < ") : "unknown";
}
